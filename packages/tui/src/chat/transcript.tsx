import { type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { Index, Show, createEffect, onCleanup } from "solid-js";
import type { Conversation } from "./conversation.ts";
import { createChatStyle, normalizeChatMarkdown } from "./markdown.ts";
import { ToolActivity } from "./tool-activity.tsx";

export function ChatTranscript(props: {
  conversation: Conversation;
  focused: boolean;
  running: boolean;
  onFocus(): void;
  onScrollRef(value: ScrollBoxRenderable): void;
}) {
  const style = createChatStyle();
  const renderer = useRenderer();
  const reasoning = props.conversation.expandedReasoning;
  let scroll: ScrollBoxRenderable | undefined;
  createEffect(() => {
    const selected = props.conversation.selected();
    if (selected) scroll?.scrollChildIntoView(`message-${selected}`);
  });
  createEffect(() => {
    const request = props.conversation.reveal();
    if (!request) return;
    // New user turns rejoin the live conversation once. Streaming never resets manual scroll.
    const reveal = () => {
      if (scroll && !scroll.isDestroyed) scroll.scrollTo(scroll.scrollHeight);
      props.conversation.acknowledgeReveal(request);
    };
    renderer.once("frame", reveal);
    renderer.requestRender();
    onCleanup(() => renderer.off("frame", reveal));
  });
  onCleanup(() => style.destroy());
  return (
    <box flexDirection="column" flexGrow={1} height="100%" backgroundColor="#111821">
      <text
        height={1}
        fg={props.focused ? "#6ee7c2" : "#94a3b8"}
        paddingLeft={1}
        onMouseDown={props.onFocus}
      >
        {`Chat · ${props.conversation.phase()} · ${props.conversation.visibleMessages().length} messages${props.focused ? " · ↑/↓ select · PgUp/PgDn scroll · Space details · F full result" : " · click to navigate"}`}
      </text>
      <scrollbox
        id="chat-history"
        flexGrow={1}
        width="100%"
        scrollX={false}
        stickyScroll
        stickyStart="bottom"
        paddingLeft={1}
        paddingRight={1}
        ref={(value: ScrollBoxRenderable) => {
          scroll = value;
          props.onScrollRef(value);
        }}
        onMouseDown={props.onFocus}
      >
        <Show
          when={props.conversation.visibleMessages().length}
          fallback={
            <text fg="#8e9ba9">
              Send a message to begin. Your conversation stays here while the agent works. Use
              /history to resume a saved conversation.
            </text>
          }
        >
          <Index each={props.conversation.visibleMessages()}>
            {(message) => (
              <box
                id={`message-${message().id}`}
                flexDirection="column"
                width="100%"
                marginBottom={1}
                backgroundColor={
                  props.conversation.selected() === message().id ? "#1d2c39" : undefined
                }
                onMouseDown={() => {
                  props.onFocus();
                  props.conversation.select(message().id);
                }}
              >
                <Show
                  when={message().role === "tool"}
                  fallback={
                    <>
                      <text fg={message().role === "user" ? "#6ee7c2" : "#38bdf8"}>
                        {`${props.conversation.selected() === message().id ? "› " : ""}${message().role === "user" ? "You" : "Assistant"}${message().status === "streaming" ? " · responding" : message().status === "failed" ? " · failed" : message().status === "aborted" ? " · canceled" : ""}`}
                      </text>
                      <Show when={message().reasoning}>
                        <text
                          fg="#94a3b8"
                          onMouseDown={() => props.conversation.toggleReasoning(message().id)}
                        >{`${reasoning().has(message().id) ? "▾" : "▸"} Reasoning · click to ${reasoning().has(message().id) ? "hide" : "show"}`}</text>
                        <Show when={reasoning().has(message().id)}>
                          <markdown
                            content={normalizeChatMarkdown(message().reasoning ?? "")}
                            syntaxStyle={style}
                            conceal
                            streaming={message().status === "streaming"}
                            fg="#94a3b8"
                            width="100%"
                          />
                        </Show>
                      </Show>
                      <Show
                        when={message().text}
                        fallback={
                          <text fg="#8e9ba9">
                            {message().status === "streaming"
                              ? "Waiting for response…"
                              : "No text response."}
                          </text>
                        }
                      >
                        <Show
                          when={message().role === "user"}
                          fallback={
                            <markdown
                              id={`message-content-${message().id}`}
                              content={normalizeChatMarkdown(message().text)}
                              syntaxStyle={style}
                              conceal
                              streaming={message().status === "streaming"}
                              width="100%"
                              tableOptions={{
                                style: "grid",
                                widthMode: "content",
                                wrapMode: "word",
                              }}
                            />
                          }
                        >
                          <text id={`message-content-${message().id}`} fg="#dce4ed" wrapMode="word">
                            {message().text}
                          </text>
                        </Show>
                      </Show>
                    </>
                  }
                >
                  <ToolActivity message={message()} conversation={props.conversation} />
                </Show>
              </box>
            )}
          </Index>
        </Show>
      </scrollbox>
      <Show when={props.running}>
        <text height={1} paddingLeft={1} fg="#fbbf24">
          {props.conversation.phase()} · Ctrl+C cancels
        </text>
      </Show>
    </box>
  );
}
