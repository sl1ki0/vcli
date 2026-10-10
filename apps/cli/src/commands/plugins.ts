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
  if (action === "list" || !action) print(await manager.list());
  else if (action === "install") {
    if (!rest[0]) throw new Error("Plugin source/name required");
    print(
      values.marketplace
        ? await manager.installFromMarketplace(values.marketplace, rest[0])
        : await manager.install(rest[0], options),
    );
  } else if (action === "remove") {
    if (!rest[0]) throw new Error("Plugin name required");
    await manager.remove(rest[0]);
    print("Plugin removed.");
  } else if (action === "marketplace") {
    const [operation, name, source] = rest;
    if (!operation || operation === "list") print(await manager.listMarketplaces());
    else if (operation === "add") {
      if (!name || !source) throw new Error("Marketplace name and source required");
      print(await manager.addMarketplace(name, source, options));
    } else if (operation === "refresh") {
      if (!name) throw new Error("Marketplace name required");
      print(await manager.refreshMarketplace(name));
    } else if (operation === "remove") {
      if (!name) throw new Error("Marketplace name required");
      await manager.removeMarketplace(name);
      print("Marketplace removed.");
    } else throw new Error("Unknown marketplace command");
  } else throw new Error("Unknown plugin command");
  return;
}
