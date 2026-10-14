import type { KeyEvent } from "@opentui/core";

/** Extended terminal protocols report the physical Latin key alongside the active layout. */
export function matchesControlKey(key: KeyEvent, letter: "c" | "p"): boolean {
  if (!key.ctrl || key.meta || key.super || key.hyper) return false;
  const code = letter.charCodeAt(0);
  return key.name.toLowerCase() === letter || key.baseCode === code || key.baseCode === code - 32;
}
