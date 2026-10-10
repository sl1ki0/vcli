import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Plugin } from "@vcli/core";
import { loadPlugin } from "./plugins.ts";
import { loadSkill } from "./skills.ts";
import { containedPath, exists, object, readJson, relativeSubdir, validateName } from "./paths.ts";

const run = promisify(execFile);
export interface InstallOptions {
  revision?: string;
  subdir?: string;
}
interface InstalledPlugin {
  name: string;
  source: string;
  revision?: string;
  subdir?: string;
  installedAt: string;
}
export interface MarketplaceEntry {
  name: string;
  description?: string;
  source: string;
  revision?: string;
  subdir?: string;
  local: boolean;
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

async function catalog(
  root: string,
): Promise<{ plugins: MarketplaceEntry[]; unsupported: string[] }> {
  const paths = [
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    "marketplace.json",
  ];
  const path = (
    await Promise.all(
      paths.map(async (path) => ((await exists(join(root, path))) ? path : undefined)),
    )
  ).find(Boolean);
  if (!path) throw new Error("No marketplace catalog found");
  const data = await readJson(await containedPath(root, path));
  if (!Array.isArray(data.plugins)) throw new Error("Marketplace plugins must be an array");
  const plugins: MarketplaceEntry[] = [];
  const unsupported: string[] = [];
  const names = new Set<string>();
  for (const value of data.plugins) {
    try {
      const entry = object(value, "Marketplace entry");
      const name = validateName(entry.name, "Marketplace plugin name");
      if (names.has(name)) throw new Error(`Duplicate marketplace plugin: ${name}`);
      let source: string;
      let local = false;
      let revision = typeof entry.revision === "string" ? entry.revision : undefined;
      let subdir = typeof entry.subdir === "string" ? relativeSubdir(entry.subdir) : undefined;
      if (typeof entry.source === "string") {
        source = entry.source;
        local = !gitSource(source);
      } else {
        const origin = object(entry.source, `Source for ${name}`);
        const kind = origin.source ?? origin.type;
        if (
          typeof origin.path === "string" &&
          (!kind || kind === "directory" || kind === "local")
        ) {
          source = origin.path;
          local = true;
        } else if (
          kind === "github" &&
          typeof origin.repo === "string" &&
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(origin.repo)
        ) {
          source = `https://github.com/${origin.repo}.git`;
        } else if ((kind === "git" || kind === "repository") && typeof origin.url === "string")
          source = origin.url;
        else throw new Error(`Marketplace plugin ${name}: unsupported source format`);
        revision =
          typeof origin.sha === "string"
            ? origin.sha
            : typeof origin.ref === "string"
              ? origin.ref
              : revision;
        subdir = typeof origin.path === "string" && !local ? relativeSubdir(origin.path) : subdir;
      }
      if (local) {
        if (!source.startsWith("./"))
          throw new Error(`Marketplace plugin ${name}: local source must start with ./`);
        await containedPath(root, source);
        if (subdir) await containedPath(root, join(source, subdir));
      } else if (!gitSource(source))
        throw new Error(`Marketplace plugin ${name}: unsupported repository URL`);
      names.add(name);
      plugins.push({
        name,
        description: typeof entry.description === "string" ? entry.description : undefined,
        source,
        local,
        revision,
        subdir,
      });
    } catch (error) {
      unsupported.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { plugins, unsupported };
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

  async list(): Promise<Plugin[]> {
    await this.mutation;
    const state = await this.state();
    return Promise.all(
      state.plugins.map(async (record) => {
        const plugin = await loadPlugin(join(this.stateRoot, "plugins", record.name), {
          dataRoot: join(this.stateRoot, "data", record.name),
        });
        return { ...plugin, source: record.source, revision: record.revision };
      }),
    );
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
    provenance?: { source: string; revision?: string; expectedName?: string },
  ): Promise<Plugin> {
    const state = await this.state();
    const staging = await this.temporary();
    let destination: string | undefined;
    let createdData: string | undefined;
    let installed = false;
    try {
      const acquired = await acquire(source, join(staging, "package"), options);
      const preview = await loadPlugin(acquired.root, { nameHint: acquired.nameHint });
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
      const plugin = await loadPlugin(destination, { dataRoot });
      plugin.source = provenance?.source ?? (gitSource(source) ? source : resolve(source));
      plugin.revision = provenance?.revision ?? acquired.revision;
      state.plugins.push({
        name: plugin.name,
        source: plugin.source,
        revision: plugin.revision,
        subdir: options.subdir,
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

  async listMarketplaces(): Promise<Marketplace[]> {
    await this.mutation;
    return (await this.state()).marketplaces;
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
      const contents = await catalog(acquired.root);
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

  installFromMarketplace(marketplaceName: string, pluginName: string): Promise<Plugin> {
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
        { revision: entry.revision, subdir: entry.subdir },
        {
          source: entry.local ? `${marketplace.source}#${entry.source}` : entry.source,
          revision: entry.local ? marketplace.revision : undefined,
          expectedName: entry.name,
        },
      );
    });
  }
}
