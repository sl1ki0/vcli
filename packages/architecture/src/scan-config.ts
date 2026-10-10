import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import { slash } from "./utils.ts";

/** Compiler options and resolution caches live for one scan, so config edits and deleted files take effect immediately. */
export function createCompilerResolver(root: string, diagnostics: string[]) {
  const optionsCache = new Map<string, ts.CompilerOptions>();
  const resolutionCaches = new Map<string, ts.ModuleResolutionCache>();
  function optionsFor(file: string): { key: string; options: ts.CompilerOptions } {
    let directory = dirname(file),
      config: string | undefined;
    while (
      directory === root ||
      (!relative(root, directory).startsWith("..") && !isAbsolute(relative(root, directory)))
    ) {
      const candidate = join(directory, "tsconfig.json");
      if (existsSync(candidate)) {
        config = candidate;
        break;
      }
      if (directory === root) break;
      directory = dirname(directory);
    }
    const key = config ?? root;
    if (!optionsCache.has(key)) {
      let options: ts.CompilerOptions = {
        allowJs: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.Latest,
        resolveJsonModule: true,
      };
      if (config) {
        const read = ts.readConfigFile(config, ts.sys.readFile);
        if (read.error)
          diagnostics.push(
            `${slash(relative(root, config))}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
          );
        else {
          const content = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config));
          options = { ...options, ...content.options };
          for (const error of content.errors.filter((e) => e.code !== 18003))
            diagnostics.push(
              `${slash(relative(root, config))}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
            );
        }
      }
      optionsCache.set(key, options);
      resolutionCaches.set(
        key,
        ts.createModuleResolutionCache(root, (name) => name, options),
      );
    }
    return { key, options: optionsCache.get(key)! };
  }
  return {
    resolve(specifier: string, file: string) {
      const { key, options } = optionsFor(file);
      return ts.resolveModuleName(specifier, file, options, ts.sys, resolutionCaches.get(key))
        .resolvedModule;
    },
    revisionOptions() {
      return [...optionsCache.entries()];
    },
  };
}
