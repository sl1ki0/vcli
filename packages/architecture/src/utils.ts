import { createHash } from "node:crypto";

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Paths without wildcards name a file or an entire directory. */
export function matchesPath(path: string, pattern: string): boolean {
  path = slash(path).replace(/^\.\//, "");
  pattern = slash(pattern).replace(/^\.\//, "").replace(/\/$/, "");
  if (pattern === "." || pattern === "**" || pattern === "**/*") return true;
  if (!/[?*]/.test(pattern)) return path === pattern || path.startsWith(`${pattern}/`);
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        expression += "(?:.*/)?";
      } else expression += ".*";
    } else if (c === "*") expression += "[^/]*";
    else if (c === "?") expression += "[^/]";
    else expression += c.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(path);
}
