import type { InputRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { createMemo, createSignal, type Accessor } from "solid-js";
import type { Conversation } from "./chat/conversation.ts";
import type { WorkspaceLayout } from "./workspace-commands.ts";
import type { createWorkspaceNavigation } from "./workspace-navigation.ts";

interface FocusOptions {
  navigation: ReturnType<typeof createWorkspaceNavigation>;
  conversation: Conversation;
  dimensions: Accessor<{ width: number; height: number }>;
}
export function createWorkspaceFocus(options: FocusOptions) {
  const [layout, setLayout] = createSignal<WorkspaceLayout>("split");
  const [chatFocus, setChatFocus] = createSignal(false);
  const [inputValue, setInputValue] = createSignal("");
  let inputRef: InputRenderable | undefined;
  let chatScroll: ScrollBoxRenderable | undefined;
  let recalled = -1;
  const navigation = options.navigation;
  const bodyHeight = createMemo(() => Math.max(4, options.dimensions().height - 7));
  const canvasHeight = createMemo(() =>
    layout() === "split" ? Math.max(3, Math.floor(bodyHeight() * 0.5)) : bodyHeight(),
  );
  const chatHeight = createMemo(() =>
    layout() === "split" ? Math.max(3, bodyHeight() - canvasHeight()) : bodyHeight(),
  );
  function clearInput() {
    setInputValue("");
    if (inputRef && !inputRef.isDestroyed) inputRef.value = "";
    recalled = -1;
  }
  function changeLayout(next: WorkspaceLayout) {
    setLayout(next);
    setChatFocus(false);
    navigation.setCanvasFocus(false);
  }
  function focusChat() {
    setChatFocus(true);
    navigation.setCanvasFocus(false);
  }
  function handleKey(key: KeyEvent): boolean {
    if (key.name === "f2" || key.name === "f3") {
      key.preventDefault();
      changeLayout(
        key.name === "f2"
          ? layout() === "chat"
            ? "split"
            : "chat"
          : layout() === "architecture"
            ? "split"
            : "architecture",
      );
      return true;
    }
    if (key.name === "tab") {
      key.preventDefault();
      if (!navigation.canvasFocus() && !chatFocus()) {
        if (layout() === "chat") focusChat();
        else navigation.setCanvasFocus(true);
      } else if (navigation.canvasFocus() && layout() !== "architecture") focusChat();
      else {
        navigation.setCanvasFocus(false);
        setChatFocus(false);
      }
      return true;
    }
    if (chatFocus()) {
      key.preventDefault();
      if (key.name === "up" || key.name === "down")
        options.conversation.jump(key.name === "up" ? "previous" : "next");
      if (key.name === "home" || key.name === "end")
        options.conversation.jump(key.name === "home" ? "first" : "last");
      if (key.name === "pageup" || key.name === "pagedown")
        chatScroll?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
      if (key.name === "escape") setChatFocus(false);
      if (key.name === "space" || key.name === "return") options.conversation.toggleDetails();
      if (key.name === "f") void options.conversation.openArtifact();
      if (key.name === "left" || key.name === "right")
        options.conversation.changeArtifactPage(key.name === "left" ? -1 : 1);
      return true;
    }
    if (
      !navigation.canvasFocus() &&
      (!inputValue() || recalled >= 0) &&
      (key.name === "up" || key.name === "down")
    ) {
      const history = options.conversation.messages().filter((message) => message.role === "user");
      if (history.length) {
        key.preventDefault();
        recalled =
          key.name === "up"
            ? Math.min(history.length - 1, recalled + 1)
            : Math.max(-1, recalled - 1);
        setInputValue(recalled < 0 ? "" : history[history.length - 1 - recalled]!.text);
        return true;
      }
    }
    return false;
  }
  return {
    layout,
    changeLayout,
    chatFocus,
    focusChat,
    bodyHeight,
    canvasHeight,
    chatHeight,
    inputValue,
    setInputValue: (value: string) => {
      if (value === inputValue()) return;
      setInputValue(value);
      recalled = -1;
    },
    clearInput,
    handleKey,
    returnToInput: () => {
      setChatFocus(false);
      navigation.setCanvasFocus(false);
    },
    setInputRef: (input: InputRenderable) => {
      inputRef = input;
    },
    setChatScroll: (scroll: ScrollBoxRenderable) => {
      chatScroll = scroll;
    },
  };
}
