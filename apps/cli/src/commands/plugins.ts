import { join } from "node:path";
import type { Plugin } from "@vcli/core";
import {
  loadPlugin,
  PluginManager,
  pluginFormat,
  pluginFormats,
  type Marketplace,
} from "@vcli/integrations";
import { configHome } from "../config.ts";
import { print } from "../io.ts";
import type { CommandContext } from "./context.ts";

/** Never serialize executable configuration, resolved credentials or source URLs. */
function pluginSummary(plugin: Plugin) {
  return {
    name: plugin.name,
    version: plugin.version,
    ecosystem: plugin.ecosystem,
    status: plugin.disabled ? "disabled" : "ready",
    root: plugin.root,
    revision: plugin.revision,
    skills: plugin.skills.map(({ name, description, path, plugin }) => ({
      name,
      description,
      path,
      plugin,
    })),
    servers: plugin.servers.map(({ name, type }) => ({ name, type })),
    unsupported: plugin.unsupported,
  };
}

function marketplaceSummary(marketplace: Marketplace) {
  return {
    name: marketplace.name,
    revision: marketplace.revision,
    root: marketplace.root,
    refreshedAt: marketplace.refreshedAt,
    plugins: marketplace.plugins.map(({ name, description, local, revision, subdir }) => ({
      name,
      description,
      local,
      revision,
      subdir,
    })),
    unsupported: marketplace.unsupported,
  };
}

export async function pluginsCommand(
  action: string | undefined,
  rest: string[],
  context: CommandContext,
) {
  const { root, values } = context;

  const manager = new PluginManager(join(configHome(), "extensions"));
  const options = { revision: values.ref, subdir: values.subdir };
  if (action === "list" || !action)
    await print((await manager.list({ workspaceRoot: root })).map(pluginSummary));
  else if (action === "formats") await print(pluginFormats);
  else if (action === "inspect") {
    if (!rest[0]) throw new Error("Plugin directory required");
    const format = values.format === undefined ? undefined : pluginFormat(values.format).id;
    await print(pluginSummary(await loadPlugin(rest[0], { workspaceRoot: root, format })));
  } else if (action === "install") {
    if (!rest[0]) throw new Error("Plugin source/name required");
    const format = values.format === undefined ? undefined : pluginFormat(values.format).id;
    await print(
      pluginSummary(
        values.marketplace
          ? await manager.installFromMarketplace(values.marketplace, rest[0], { format })
          : await manager.install(rest[0], { ...options, format }),
      ),
    );
  } else if (action === "remove") {
    if (!rest[0]) throw new Error("Plugin name required");
    await manager.remove(rest[0]);
    await print("Plugin removed.");
  } else if (action === "marketplace") {
    const [operation, name, source] = rest;
    if (!operation || operation === "list")
      await print((await manager.listMarketplaces()).map(marketplaceSummary));
    else if (operation === "add") {
      if (!name || !source) throw new Error("Marketplace name and source required");
      await print(marketplaceSummary(await manager.addMarketplace(name, source, options)));
    } else if (operation === "refresh") {
      if (!name) throw new Error("Marketplace name required");
      await print(marketplaceSummary(await manager.refreshMarketplace(name)));
    } else if (operation === "remove") {
      if (!name) throw new Error("Marketplace name required");
      await manager.removeMarketplace(name);
      await print("Marketplace removed.");
    } else throw new Error("Unknown marketplace command");
  } else throw new Error("Unknown plugin command");
  return;
}
