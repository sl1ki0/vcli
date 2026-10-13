import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Plugin, PluginEcosystem } from "@vcli/core";
import { loadPlugin, type LoadPluginOptions } from "./plugins.ts";
import { loadSkill } from "./skills.ts";
import { pluginFormat } from "./formats.ts";
import { containedPath, exists, relativeSubdir, validateName } from "./paths.ts";
import { readMarketplaceCatalog, type MarketplaceEntry } from "./catalogs.ts";
export type { MarketplaceEntry } from "./catalogs.ts";

const run = promisify(execFile);
export interface InstallOptions {
  revision?: string;
  subdir?: string;
  format?: PluginEcosystem;
}
interface InstalledPlugin {
  name: string;
  source: string;
  revision?: string;
  subdir?: string;
  format?: PluginEcosystem;
  marketplaceManifest?: Record<string, unknown>;
  marketplaceStrict?: boolean;
  ecosystem?: PluginEcosystem;
  manifestRequired?: boolean;
  installedAt: string;
}
export interface Marketplace {
  name: string;
  source: string;
  revision?: string;
  pinnedRevision?: string;
  subdir?: string;
  root: string;
  refreshedAt: string;
  plugins: MarketplaceEntry[];
  unsupported: string[];
}
interface State {
  version: 1;
  plugins: InstalledPlugin[];
  marketplaces: Marketplace[];
}

function gitSource(source: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|git@|git\+|file:\/\/)/.test(source);
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return stdout.trim();
}

async function copyPackage(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => ![".git", "node_modules"].includes(basename(path)),
  });
}

async function acquire(
  source: string,
  destination: string,
  options: InstallOptions,
): Promise<{ root: string; revision?: string; nameHint: string }> {
  const subdir = relativeSubdir(options.subdir);
  if (!gitSource(source)) {
    const root = await containedPath(resolve(source), subdir);
    await copyPackage(root, destination);
    return { root: destination, nameHint: basename(root) };
  }
  const url = source.replace(/^git\+/, "");
  if (options.revision && !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(options.revision))
    throw new Error("Invalid Git revision");
  const checkout = `${destination}-checkout`;
  try {
    await git([
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--no-recurse-submodules",
      "--",
      url,
      checkout,
    ]);
    let revision: string;
    if (options.revision) {
      try {
        revision = await git([
          "-C",
          checkout,
          "rev-parse",
          "--verify",
          `${options.revision}^{commit}`,
        ]);
      } catch {
        await git(["-C", checkout, "fetch", "--depth=1", "origin", options.revision]);
        revision = await git(["-C", checkout, "rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
      }
    } else revision = await git(["-C", checkout, "rev-parse", "--verify", "HEAD^{commit}"]);
    await git(["-C", checkout, "checkout", "--detach", revision]);
    const root = await containedPath(checkout, subdir);
    await copyPackage(root, destination);
    return {
      root: destination,
      revision,
      nameHint:
        options.subdir && options.subdir !== "."
          ? basename(root)
          : basename(url).replace(/\.git$/, ""),
    };
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

/** Stores immutable snapshots; updates happen only through an explicit refresh/install. */
export class PluginManager {
  readonly stateRoot: string;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot);
  }

  private async state(): Promise<State> {
    const path = join(this.stateRoot, "integrations.json");
    if (!(await exists(path))) return { version: 1, plugins: [], marketplaces: [] };
    const value = JSON.parse(await readFile(path, "utf8")) as State;
    if (value.version !== 1 || !Array.isArray(value.plugins) || !Array.isArray(value.marketplaces))
      throw new Error("Invalid integrations state");
    for (const plugin of value.plugins) validateName(plugin.name);
    for (const marketplace of value.marketplaces) validateName(marketplace.name);
    return value;
  }

  private async save(state: State): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true });
    const target = join(this.stateRoot, "integrations.json");
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => undefined);
    return next;
  }

  private async temporary(): Promise<string> {
    await mkdir(this.stateRoot, { recursive: true });
    return mkdtemp(join(this.stateRoot, ".install-"));
  }

  list(options: Pick<LoadPluginOptions, "workspaceRoot"> = {}): Promise<Plugin[]> {
    return this.serialize(async () => {
      const state = await this.state();
      return Promise.all(
        state.plugins.map(async (record) => {
          const root = join(this.stateRoot, "plugins", record.name);
          try {
            const plugin = await loadPlugin(root, {
              dataRoot: join(this.stateRoot, "data", record.name),
              ...options,
              format: record.format,
              marketplaceManifest: record.marketplaceManifest,
              marketplaceStrict: record.marketplaceStrict,
              requireManifest: record.manifestRequired,
            });
            if (plugin.name !== record.name) throw new Error("Installed plugin identity changed");
            return { ...plugin, source: record.source, revision: record.revision };
          } catch (error) {
            return {
              name: record.name,
              version: "unknown",
              root,
              source: record.source,
              revision: record.revision,
              ecosystem: record.ecosystem ?? record.format ?? "unknown",
              disabled: true,
              skills: [],
              servers: [],
              unsupported: [
                `Plugin disabled: ${error instanceof Error ? error.message : String(error)}`,
              ],
            } satisfies Plugin;
          }
        }),
      );
    });
  }

  async loadSkill(name: string): Promise<string> {
    return loadSkill(
      name,
      (await this.list()).flatMap((plugin) => plugin.skills),
    );
  }

  install(source: string, options: InstallOptions = {}): Promise<Plugin> {
    return this.serialize(() => this.installSnapshot(source, options));
  }

  private async installSnapshot(
    source: string,
    options: InstallOptions,
    provenance?: {
      source: string;
      revision?: string;
      expectedName?: string;
      marketplaceManifest?: Record<string, unknown>;
      marketplaceStrict?: boolean;
    },
  ): Promise<Plugin> {
    const state = await this.state();
    const staging = await this.temporary();
    let destination: string | undefined;
    let createdData: string | undefined;
    let installed = false;
    try {
      const acquired = await acquire(source, join(staging, "package"), options);
      const importOptions = {
        nameHint: acquired.nameHint,
        format: options.format,
        marketplaceManifest: provenance?.marketplaceManifest,
        marketplaceStrict: provenance?.marketplaceStrict,
        requireManifest: false,
      };
      const preview = await loadPlugin(acquired.root, importOptions);
      const format = pluginFormat(preview.ecosystem);
      importOptions.requireManifest = await exists(join(acquired.root, format.manifest));
      if (importOptions.requireManifest) importOptions.format = format.id;
      if (provenance?.expectedName && preview.name !== provenance.expectedName)
        throw new Error(
          `Catalog plugin ${provenance.expectedName} has manifest name ${preview.name}`,
        );
      if (state.plugins.some((plugin) => plugin.name === preview.name))
        throw new Error(
          `Plugin ${preview.name} is already installed; remove it before replacing it`,
        );
      destination = join(this.stateRoot, "plugins", preview.name);
      if (await exists(destination))
        throw new Error(`Plugin destination already exists: ${preview.name}`);
      await mkdir(join(this.stateRoot, "plugins"), { recursive: true });
      await rename(acquired.root, destination);
      installed = true;
      const dataRoot = join(this.stateRoot, "data", preview.name);
      if (!(await exists(dataRoot))) createdData = dataRoot;
      await mkdir(dataRoot, { recursive: true });
      const plugin = await loadPlugin(destination, { ...importOptions, dataRoot });
      plugin.source = provenance?.source ?? (gitSource(source) ? source : resolve(source));
      plugin.revision = provenance?.revision ?? acquired.revision;
      state.plugins.push({
        name: plugin.name,
        source: plugin.source,
        revision: plugin.revision,
        subdir: options.subdir,
        format: importOptions.format,
        manifestRequired: importOptions.requireManifest,
        marketplaceManifest: provenance?.marketplaceManifest,
        marketplaceStrict: provenance?.marketplaceStrict,
        ecosystem: plugin.ecosystem === "unknown" ? undefined : plugin.ecosystem,
        installedAt: new Date().toISOString(),
      });
      await this.save(state);
      return plugin;
    } catch (error) {
      if (installed && destination) await rm(destination, { recursive: true, force: true });
      if (createdData) await rm(createdData, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  remove(name: string): Promise<void> {
    validateName(name);
    return this.serialize(async () => {
      const state = await this.state();
      if (!state.plugins.some((plugin) => plugin.name === name))
        throw new Error(`Unknown plugin: ${name}`);
      state.plugins = state.plugins.filter((plugin) => plugin.name !== name);
      await this.removeSnapshots(state, [
        join(this.stateRoot, "plugins", name),
        join(this.stateRoot, "data", name),
      ]);
    });
  }

  private async removeSnapshots(state: State, paths: string[]): Promise<void> {
    const staging = await this.temporary();
    const moved: { original: string; staged: string }[] = [];
    let cleanup = false;
    try {
      for (const [index, original] of paths.entries()) {
        if (!(await exists(original))) continue;
        const staged = join(staging, String(index));
        await rename(original, staged);
        moved.push({ original, staged });
      }
      await this.save(state);
      cleanup = true;
    } catch (error) {
      // Keep recovery files if restoring a rename fails; never erase the only remaining snapshot.
      try {
        for (const entry of moved.reverse()) await rename(entry.staged, entry.original);
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          `Removal rollback failed; recovery files retained at ${staging}`,
        );
      }
      cleanup = true;
      throw error;
    } finally {
      if (cleanup) await rm(staging, { recursive: true, force: true });
    }
  }

  addMarketplace(name: string, source: string, options: InstallOptions = {}): Promise<Marketplace> {
    validateName(name);
    return this.serialize(async () => {
      const state = await this.state();
      if (state.marketplaces.some((marketplace) => marketplace.name === name))
        throw new Error(`Marketplace ${name} is already registered`);
      return this.writeMarketplace(state, name, source, options);
    });
  }

  listMarketplaces(): Promise<Marketplace[]> {
    return this.serialize(async () => (await this.state()).marketplaces);
  }

  refreshMarketplace(name: string): Promise<Marketplace> {
    validateName(name);
    return this.serialize(async () => {
      const state = await this.state();
      const old = state.marketplaces.find((marketplace) => marketplace.name === name);
      if (!old) throw new Error(`Unknown marketplace: ${name}`);
      return this.writeMarketplace(state, name, old.source, {
        revision: old.pinnedRevision,
        subdir: old.subdir,
      });
    });
  }

  private async writeMarketplace(
    state: State,
    name: string,
    source: string,
    options: InstallOptions,
  ): Promise<Marketplace> {
    const staging = await this.temporary();
    const destination = join(this.stateRoot, "marketplaces", name);
    const backup = join(staging, "previous");
    let replaced = false;
    let installed = false;
    let cleanup = false;
    try {
      const acquired = await acquire(source, join(staging, "catalog"), options);
      const contents = await readMarketplaceCatalog(acquired.root);
      await mkdir(join(this.stateRoot, "marketplaces"), { recursive: true });
      if (await exists(destination)) {
        await rename(destination, backup);
        replaced = true;
      }
      await rename(acquired.root, destination);
      installed = true;
      const marketplace: Marketplace = {
        name,
        source: gitSource(source) ? source : resolve(source),
        revision: acquired.revision,
        pinnedRevision: options.revision,
        subdir: options.subdir,
        root: destination,
        refreshedAt: new Date().toISOString(),
        ...contents,
      };
      state.marketplaces = [
        ...state.marketplaces.filter((marketplace) => marketplace.name !== name),
        marketplace,
      ];
      await this.save(state);
      cleanup = true;
      return marketplace;
    } catch (error) {
      try {
        if (installed) await rm(destination, { recursive: true, force: true });
        if (replaced) await rename(backup, destination);
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          `Marketplace rollback failed; recovery files retained at ${staging}`,
        );
      }
      cleanup = true;
      throw error;
    } finally {
      if (cleanup) await rm(staging, { recursive: true, force: true });
    }
  }

  removeMarketplace(name: string): Promise<void> {
    validateName(name);
    return this.serialize(async () => {
      const state = await this.state();
      if (!state.marketplaces.some((marketplace) => marketplace.name === name))
        throw new Error(`Unknown marketplace: ${name}`);
      state.marketplaces = state.marketplaces.filter((marketplace) => marketplace.name !== name);
      await this.removeSnapshots(state, [join(this.stateRoot, "marketplaces", name)]);
    });
  }

  installFromMarketplace(
    marketplaceName: string,
    pluginName: string,
    options: Pick<InstallOptions, "format"> = {},
  ): Promise<Plugin> {
    validateName(marketplaceName);
    validateName(pluginName);
    return this.serialize(async () => {
      const marketplace = (await this.state()).marketplaces.find(
        (item) => item.name === marketplaceName,
      );
      const entry = marketplace?.plugins.find((item) => item.name === pluginName);
      if (!marketplace || !entry)
        throw new Error(`Unknown marketplace plugin: ${pluginName}@${marketplaceName}`);
      const source = entry.local
        ? await containedPath(marketplace.root, entry.source)
        : entry.source;
      return this.installSnapshot(
        source,
        { revision: entry.revision, subdir: entry.subdir, format: options.format },
        {
          source: entry.local ? `${marketplace.source}#${entry.source}` : entry.source,
          revision: entry.local ? marketplace.revision : undefined,
          expectedName: entry.name,
          marketplaceManifest: entry.manifest,
          marketplaceStrict: entry.strict,
        },
      );
    });
  }
}
