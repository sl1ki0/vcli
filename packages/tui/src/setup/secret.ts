import type { KeyEvent, PasteEvent } from "@opentui/core";
import { createSignal } from "solid-js";

/** Only the mask is reactive. The key never becomes an Input value or view prop. */
export function createSecretCapture() {
  let value = "";
  const [mask, setMask] = createSignal("");
  const updateMask = () => setMask("•".repeat(Math.min([...value].length, 48)));
  function append(text: string) {
    value = (value + text.replace(/[\x00-\x1f\x7f]/g, "")).slice(0, 4096);
    updateMask();
  }
  function clear() {
    value = "";
    setMask("");
  }
  function take() {
    const key = value.trim();
    clear();
    return key || undefined;
  }
  function handleKey(key: KeyEvent) {
    key.preventDefault();
    key.stopPropagation();
    if (key.name === "backspace" || key.name === "delete") {
      value = [...value].slice(0, -1).join("");
      updateMask();
    } else if (key.ctrl && key.name === "u") clear();
    else if (!key.ctrl && !key.meta && !key.super && !key.hyper) {
      const text = key.sequence;
      if (text && !/[\x00-\x1f\x7f]/.test(text)) append(text);
    }
  }
  function handlePaste(event: PasteEvent) {
    event.preventDefault();
    event.stopPropagation();
    append(new TextDecoder().decode(event.bytes));
  }
  return { mask, clear, take, handleKey, handlePaste, hasValue: () => Boolean(value.trim()) };
}
