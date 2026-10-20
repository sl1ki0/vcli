import { resolve } from "node:path";
import type { CliValues } from "./args.ts";

/** These local execution settings never contain provider credentials. */
export function runOptions(values: CliValues) {
  const directory = values["state-dir"] ?? process.env.VCLI_STATE_DIR;
  const policy = values.policy ?? process.env.VCLI_POLICY;
  return {
    ...(directory ? { stateDirectory: resolve(directory) } : {}),
    ...(policy ? { policyPath: resolve(policy) } : {}),
  };
}

export function storeOptions(values: CliValues) {
  return { directory: runOptions(values).stateDirectory };
}
