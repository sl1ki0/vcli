import type { ArchitectureService } from "@vcli/core";
import type { CliValues } from "../args.ts";
import type { Config } from "../config.ts";
export interface CommandContext {
  root: string;
  config: Config;
  architecture: ArchitectureService;
  values: CliValues;
}
