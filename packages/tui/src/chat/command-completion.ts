import type { KeyEvent } from "@opentui/core";
import { createMemo, createSignal, type Accessor } from "solid-js";
import { workspaceCommandList } from "../setup/commands.ts";
import { reasoningChoices } from "../setup/reasoning.ts";

interface CommandSuggestion {
  value: string;
  description: string;
}

/** Complete only local commands and known arguments; never infer paths or task text. */
export function commandSuggestions(input: string): CommandSuggestion[] {
  const match = /^\s*(\/\S*)(\s+([^\s]*))?$/.exec(input);
  if (!match) return [];
  const name = match[1]!;
  if (match[2] !== undefined) {
    const values =
      name === "/reasoning"
        ? reasoningChoices
        : ["/permission", "/permissions"].includes(name)
          ? [
              { value: "yolo", description: "Allow changes without approval" },
              { value: "ask", description: "Approve writes and commands" },
              { value: "read-only", description: "Allow reads only" },
            ]
          : [];
    return values
      .filter((item) => item.value.startsWith(match[3]!))
      .map((item) => ({ value: `${name} ${item.value}`, description: item.description }));
  }
  return workspaceCommandList
    .filter((item) => item.command.startsWith(name))
    .map((item) => ({
      value:
        item.command +
        (["/permission", "/permissions", "/reasoning", "/open", "/rewind"].includes(item.command)
          ? " "
          : ""),
      description: item.description,
    }));
}

export function createCommandCompletion(options: {
  input: Accessor<string>;
  enabled: Accessor<boolean>;
  capacity: Accessor<number>;
  replace(value: string): void;
}) {
  const query = createMemo(() => ({ value: options.input() }));
  const [hidden, setHidden] = createSignal<{ value: string }>();
  const [selection, setSelection] = createSignal({ query: query(), index: 0 });
  const items = createMemo(() =>
    options.enabled() && hidden() !== query() && options.capacity() > 0
      ? commandSuggestions(query().value)
      : [],
  );
  const selected = () => (selection().query === query() ? selection().index : 0);
  const rows = createMemo(() => {
    const limit = Math.max(1, options.capacity());
    const start = Math.floor(selected() / limit) * limit;
    return items()
      .slice(start, start + limit)
      .map((item, offset) => ({ ...item, index: start + offset }));
  });
  function accept(index = selected()) {
    const item = items()[index];
    if (!item) return;
    // Completing a command with arguments opens its argument suggestions.
    options.replace(item.value);
    setHidden(item.value.endsWith(" ") ? undefined : query());
    setSelection({ query: query(), index: 0 });
  }
  function handleKey(key: KeyEvent) {
    if (!items().length || key.ctrl || key.meta || key.super || key.hyper) return false;
    if (!["up", "down", "tab", "return", "escape"].includes(key.name)) return false;
    // Fully typed commands keep Enter's usual submit behavior.
    if (key.name === "return" && items()[selected()]?.value.trim() === options.input().trim())
      return false;
    key.preventDefault();
    key.stopPropagation();
    if (key.name === "escape") setHidden(query());
    else if (key.name === "up" || key.name === "down" || (key.name === "tab" && key.shift)) {
      const direction = key.name === "up" || key.shift ? -1 : 1;
      setSelection({
        query: query(),
        index: (selected() + direction + items().length) % items().length,
      });
    } else accept();
    return true;
  }
  return {
    items,
    rows,
    selected,
    accept,
    handleKey,
    height: () => (rows().length ? rows().length + 1 : 0),
  };
}
