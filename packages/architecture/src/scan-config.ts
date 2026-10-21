import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import { slash } from "./utils.ts";

/** Compiler options and resolution caches live for one scan, so config edits and deleted files take effect immediately. */
export function createCompilerResolver(
  root: string,
  diagnostics: string[],
  allowedPaths?: Set<string>,
) {
  const canonicalRoot = realpathSync(root);
  const withinRoot = (path: string): boolean => {
    const part = relative(canonicalRoot, realpathSync(path));
    return (
      part !== ".." &&
      !part.startsWith("../") &&
      !isAbsolute(part) &&
      ![".vcli", ".git"].includes(part.split(/[\\/]/)[0]!.toLowerCase())
    );
  };
  const fileExists = (path: string): boolean => {
    try {
      const info = lstatSync(path);
      return (
        info.isFile() &&
        info.nlink === 1 &&
        withinRoot(path) &&
        (!allowedPaths || allowedPaths.has(path))
      );
    } catch {
      return false;
    }
  };
  const directoryExists = (path: string): boolean => {
    try {
      return lstatSync(path).isDirectory() && withinRoot(path);
    } catch {
      return false;
    }
  };
  const readFile = (path: string): string | undefined => {
    if (!fileExists(path)) return undefined;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(descriptor);
      const maximum = 1024 * 1024;
      if (!info.isFile() || info.nlink !== 1 || info.size > maximum) return undefined;
      const buffer = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(descriptor, buffer, length, buffer.length - length, length);
        if (!count) break;
        length += count;
      }
      return length <= maximum ? buffer.subarray(0, length).toString("utf8") : undefined;
    } catch {
      return undefined;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
  const host: ts.ParseConfigHost & ts.ModuleResolutionHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists,
    directoryExists,
    readFile,
    // Only compiler options are needed: the inventory already owns file traversal.
    readDirectory: () => [],
    getCurrentDirectory: () => root,
    realpath: (path) => realpathSync(path),
  };
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
      if (fileExists(candidate)) {
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
        const read = ts.readConfigFile(config, readFile);
        if (read.error)
          diagnostics.push(
            `${slash(relative(root, config))}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
          );
        else {
          const content = ts.parseJsonConfigFileContent(read.config, host, dirname(config));
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
      return ts.resolveModuleName(specifier, file, options, host, resolutionCaches.get(key))
        .resolvedModule;
    },
    revisionOptions() {
      return [...optionsCache.entries()];
    },
  };
}
