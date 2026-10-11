import { join } from "node:path";
import { PluginManager } from "@vcli/integrations";
import { configHome } from "../config.ts";
import { print } from "../io.ts";
import type { CommandContext } from "./context.ts";
export async function pluginsCommand(
  action: string | undefined,
  rest: string[],
  context: CommandContext,
) {
  const { root, config, architecture, values } = context;

  const manager = new PluginManager(join(configHome(), "extensions"));
  const options = { revision: values.ref, subdir: values.subdir };
  if (action === "list" || !action) await print(await manager.list());
  else if (action === "install") {
    if (!rest[0]) throw new Error("Plugin source/name required");
    await print(
      values.marketplace
        ? await manager.installFromMarketplace(values.marketplace, rest[0])
        : await manager.install(rest[0], options),
    );
  } else if (action === "remove") {
    if (!rest[0]) throw new Error("Plugin name required");
    await manager.remove(rest[0]);
    await print("Plugin removed.");
  } else if (action === "marketplace") {
    const [operation, name, source] = rest;
    if (!operation || operation === "list") await print(await manager.listMarketplaces());
    else if (operation === "add") {
      if (!name || !source) throw new Error("Marketplace name and source required");
      await print(await manager.addMarketplace(name, source, options));
    } else if (operation === "refresh") {
      if (!name) throw new Error("Marketplace name required");
      await print(await manager.refreshMarketplace(name));
    } else if (operation === "remove") {
      if (!name) throw new Error("Marketplace name required");
      await manager.removeMarketplace(name);
      await print("Marketplace removed.");
    } else throw new Error("Unknown marketplace command");
  } else throw new Error("Unknown plugin command");
  return;
}
