import { createMemo, createSignal } from "solid-js";
import type { ChatMessage, RuntimeEvent, Session } from "@vcli/core";

export function sessionMessages(session: Session): ChatMessage[] {
  if (session.chat) return session.chat;
  return session.messages.flatMap((message, index) =>
    (message.role === "user" || message.role === "assistant") && typeof message.text === "string"
      ? [
          {
            id: `${session.id}:${index}`,
            role: message.role,
            text: message.text,
            createdAt: session.createdAt,
            status: "complete" as const,
          },
        ]
      : [],
  );
}

/** The visible conversation survives model-context compaction and separate task turns. */
export function createConversation(initial?: Session) {
  const [messages, setMessages] = createSignal<ChatMessage[]>(
    initial ? sessionMessages(initial) : [],
  );
  const [session, setSession] = createSignal(initial);
  const [phase, setPhase] = createSignal("Ready");
  const [selected, setSelected] = createSignal<string>();
  const [expandedReasoning, setExpandedReasoning] = createSignal<Set<string>>(new Set());
  const [reveal, setReveal] = createSignal<string>();
  const visibleMessages = createMemo(() =>
    messages().filter(
      (message) =>
        message.role === "user" ||
        message.text ||
        message.reasoning ||
        message.status !== "complete",
    ),
  );
  let pendingUser: string | undefined;
  let assistantId: string | undefined;
  const localFailures = new Set<string>();

  function replace(id: string, update: Partial<ChatMessage>) {
    setMessages((previous) =>
      previous.map((message) => (message.id === id ? { ...message, ...update } : message)),
    );
  }
  function assistant(id = assistantId ?? crypto.randomUUID(), time = new Date().toISOString()) {
    assistantId = id;
    if (!messages().some((message) => message.id === id))
      setMessages((previous) => [
        ...previous,
        { id, role: "assistant", text: "", createdAt: time, status: "streaming" },
      ]);
    return id;
  }
  function send(text: string) {
    pendingUser = crypto.randomUUID();
    assistantId = undefined;
    setMessages((previous) => [
      ...previous,
      {
        id: pendingUser!,
        role: "user",
        text,
        createdAt: new Date().toISOString(),
        status: "complete",
      },
    ]);
    setSelected(undefined);
    setReveal(pendingUser);
    setPhase("Waiting for model…");
  }
  function accept(event: RuntimeEvent) {
    const id =
      typeof event.data.messageId === "string"
        ? event.data.messageId
        : typeof event.data.id === "string"
          ? event.data.id
          : undefined;
    if (event.type === "message-start") {
      if (event.data.role === "user") {
        const update: Partial<ChatMessage> = {
          id,
          createdAt: String(event.data.createdAt ?? event.time),
          status: "complete",
        };
        if (typeof event.data.text === "string") update.text = event.data.text;
        if (pendingUser) {
          localFailures.delete(pendingUser);
          replace(pendingUser, update);
        }
        pendingUser = undefined;
      } else assistant(id, String(event.data.createdAt ?? event.time));
    }
    if (event.type === "text" || event.type === "reasoning") {
      const target = assistant(id);
      const message = messages().find((item) => item.id === target)!;
      const delta = String(event.data.text ?? "");
      replace(
        target,
        event.type === "text"
          ? { text: message.text + delta }
          : { reasoning: (message.reasoning ?? "") + delta },
      );
      setPhase(event.type === "text" ? "Responding…" : "Thinking…");
    }
    if (event.type === "message-end") {
      const target = id ?? assistantId;
      const status = event.data.status;
      if (target)
        replace(target, {
          status: status === "aborted" || status === "failed" ? status : "complete",
        });
      assistantId = undefined;
    }
    if (event.type === "tool-start") setPhase(`Using ${String(event.data.name)}…`);
    if (event.type === "tool-end") setPhase("Waiting for model…");
  }
  function restore(next: Session) {
    setSession(next);
    setMessages(sessionMessages(next));
    pendingUser = undefined;
    assistantId = undefined;
    localFailures.clear();
    setSelected(undefined);
    setReveal(undefined);
    setExpandedReasoning(new Set<string>());
    setPhase(next.status === "aborted" ? "Interrupted · send a message to continue" : "Ready");
  }
  function finish(next?: Session, status: "complete" | "failed" | "aborted" = "complete") {
    if (next?.chat) {
      const failed = messages().filter((message) => localFailures.has(message.id));
      setSession(next);
      const durable = sessionMessages(next);
      const restored = [
        ...durable,
        ...failed.filter((message) => !durable.some((item) => item.id === message.id)),
      ];
      restored.sort((left, right) => {
        const a = Date.parse(left.createdAt),
          b = Date.parse(right.createdAt);
        return Number.isFinite(a) && Number.isFinite(b) ? a - b : 0;
      });
      setMessages(restored);
      pendingUser = undefined;
      assistantId = undefined;
    } else {
      if (next) setSession(next);
      setMessages((previous) =>
        previous.map((message) =>
          message.status === "streaming" ? { ...message, status } : message,
        ),
      );
      assistantId = undefined;
      if (pendingUser && status !== "complete") {
        replace(pendingUser, { status });
        localFailures.add(pendingUser);
        pendingUser = undefined;
      }
    }
    setPhase(
      status === "aborted"
        ? "Canceled · send a message to continue"
        : status === "failed"
          ? "Failed · see task activity"
          : "Ready",
    );
  }
  function clear() {
    setMessages([]);
    setSession(undefined);
    setSelected(undefined);
    setReveal(undefined);
    setExpandedReasoning(new Set<string>());
    pendingUser = undefined;
    assistantId = undefined;
    localFailures.clear();
    setPhase("Ready");
  }
  function jump(direction: "previous" | "next" | "first" | "last") {
    const all = visibleMessages();
    if (!all.length) return;
    const index = all.findIndex((message) => message.id === selected());
    const next =
      direction === "first"
        ? 0
        : direction === "last"
          ? all.length - 1
          : direction === "previous"
            ? Math.max(0, (index < 0 ? all.length : index) - 1)
            : Math.min(all.length - 1, index + 1);
    setSelected(all[next]?.id);
  }
  function toggleReasoning(id = selected()) {
    if (!id || !messages().find((message) => message.id === id)?.reasoning) return;
    setExpandedReasoning((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  return {
    messages,
    visibleMessages,
    session,
    phase,
    selected,
    expandedReasoning,
    reveal,
    acknowledgeReveal: (request: string) => {
      if (reveal() === request) setReveal(undefined);
    },
    toggleReasoning,
    send,
    accept,
    restore,
    finish,
    clear,
    jump,
    select: setSelected,
  };
}
export type Conversation = ReturnType<typeof createConversation>;
