import type { ArchitectureService } from "@vcli/core";
import { ProjectPolicy } from "./policy.ts";

/** Apply directory policy before source discovery, parsing, compiler resolution or caching. */
export function scopedArchitecture(
  architecture: ArchitectureService,
  policyPath?: string,
  stateDirectory?: string,
): ArchitectureService {
  if (!policyPath) return architecture;
  return {
    ...architecture,
    async scan(root, scope) {
      const policy = await ProjectPolicy.load(root, policyPath, { stateDirectory });
      return architecture.scan(root, {
        allowDirectory: async (path) =>
          (await policy.canTraverseDirectory(path)) &&
          (!scope || (await scope.allowDirectory(path))),
        allowFile: async (path) => {
          try {
            await policy.resolvePath(path);
            return !scope || (await scope.allowFile(path));
          } catch {
            return false;
          }
        },
      });
    },
  };
}
