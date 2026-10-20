import { createMemo, createSignal } from "solid-js";
import {
  applyToolConversationEvent,
  displayToolText,
  type ChatMessage,
  type RuntimeEvent,
  type RunPlanState,
  type Session,
} from "@vcli/core";
import { toolPageStride } from "./tool-text.ts";

export interface ArtifactView {
  loading: boolean;
  content?: string;
  error?: string;
  page: number;
}

function interruptUnfinishedTools(messages: ChatMessage[], status: string): ChatMessage[] {
  if (status === "complete") return messages;
  return messages.map((message) => {
    if (message.tool && (message.tool.state === "requested" || message.tool.state === "running"))
      return {
        ...message,
        status: "aborted" as const,
        tool: { ...message.tool, state: "interrupted" as const },
        text:
          message.text || "No completion was recorded. Inspect the current state before retrying.",
      };
    return message;
  });
}

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
export function createConversation(
  initial?: Session,
  readArtifact?: (id: string) => Promise<string>,
) {
  const [messages, setMessages] = createSignal<ChatMessage[]>(
    initial ? sessionMessages(initial) : [],
  );
  const [session, setSession] = createSignal(initial);
  const [plan, setPlan] = createSignal<RunPlanState | undefined>(initial?.plan);
  const [phase, setPhase] = createSignal("Ready");
  const [selected, setSelected] = createSignal<string>();
  const [expandedReasoning, setExpandedReasoning] = createSignal<Set<string>>(new Set());
  const [expandedTools, setExpandedTools] = createSignal<Set<string>>(new Set());
  const [artifacts, setArtifacts] = createSignal<Record<string, ArtifactView>>({});
  const [reveal, setReveal] = createSignal<string>();
  const visibleMessages = createMemo(() =>
    messages().filter(
      (message) =>
        message.role === "user" ||
        message.role === "tool" ||
        message.text ||
        message.reasoning ||
        message.status !== "complete",
    ),
  );
  let pendingUser: string | undefined;
  let assistantId: string | undefined;
  let artifactGeneration = 0;
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
    if (event.type === "plan") {
      const next = event.data.plan as RunPlanState | undefined;
      if (next) setPlan(structuredClone(next));
      const id = event.data.messageId;
      const content = event.data.text;
      if (typeof id === "string" && typeof content === "string") {
        if (messages().some((message) => message.id === id)) replace(id, { text: content });
        else {
          setMessages((previous) => [
            ...previous,
            {
              id,
              role: "assistant",
              text: content,
              createdAt: String(event.data.createdAt ?? event.time),
              status: "complete",
            },
          ]);
          setReveal(id);
        }
      }
      return;
    }
    if (event.type === "tool-request" || event.type === "tool-start" || event.type === "tool-end") {
      setMessages((previous) => {
        const next = previous.map((message) =>
          message.role === "tool" && message.tool && message.tool.callId === event.data.callId
            ? { ...message, tool: { ...message.tool } }
            : message,
        );
        applyToolConversationEvent(next, event);
        return next;
      });
      setPhase(
        event.type === "tool-end"
          ? "Waiting for model…"
          : `${event.type === "tool-start" ? "Using" : "Requested"} ${String(event.data.name)}…`,
      );
      return;
    }
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
  }
  function restore(next: Session) {
    artifactGeneration++;
    setSession(next);
    setPlan(next.plan);
    setMessages(sessionMessages(next));
    pendingUser = undefined;
    assistantId = undefined;
    localFailures.clear();
    setSelected(undefined);
    setReveal(undefined);
    setExpandedReasoning(new Set<string>());
    setExpandedTools(new Set<string>());
    setArtifacts({});
    setPhase(next.status === "aborted" ? "Interrupted · send a message to continue" : "Ready");
  }
  function finish(next?: Session, status: "complete" | "failed" | "aborted" = "complete") {
    if (next?.chat) {
      const failed = messages().filter((message) => localFailures.has(message.id));
      setSession(next);
      setPlan(next.plan);
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
      setMessages(interruptUnfinishedTools(restored, status));
      pendingUser = undefined;
      assistantId = undefined;
    } else {
      if (next) {
        setSession(next);
        setPlan(next.plan);
      }
      setMessages((previous) =>
        interruptUnfinishedTools(previous, status).map((message) =>
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
    artifactGeneration++;
    setMessages([]);
    setSession(undefined);
    setPlan(undefined);
    setSelected(undefined);
    setReveal(undefined);
    setExpandedReasoning(new Set<string>());
    setExpandedTools(new Set<string>());
    setArtifacts({});
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
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleDetails(id = selected()) {
    if (!id) return;
    if (messages().find((message) => message.id === id)?.role !== "tool") {
      toggleReasoning(id);
      return;
    }
    setExpandedTools((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function openArtifact(id = selected()) {
    if (!id || !readArtifact) return;
    const artifact = messages().find((message) => message.id === id)?.tool?.artifact;
    if (!artifact || artifacts()[id]?.loading || artifacts()[id]?.content !== undefined) return;
    const generation = artifactGeneration;
    setExpandedTools((previous) => new Set([...previous, id]));
    setArtifacts((previous) => ({ ...previous, [id]: { loading: true, page: 0 } }));
    try {
      const content = displayToolText(await readArtifact(artifact));
      if (artifactGeneration !== generation || !messages().some((message) => message.id === id))
        return;
      setArtifacts((previous) => ({ ...previous, [id]: { loading: false, content, page: 0 } }));
    } catch {
      if (artifactGeneration !== generation || !messages().some((message) => message.id === id))
        return;
      setArtifacts((previous) => ({
        ...previous,
        [id]: { loading: false, error: "Full result could not be opened. Try again.", page: 0 },
      }));
    }
  }
  function changeArtifactPage(direction: number, id = selected()) {
    if (!id || !expandedTools().has(id)) return;
    const view = artifacts()[id];
    if (!view || view.content === undefined) return;
    const page = Math.max(
      0,
      Math.min(
        Math.max(0, Math.ceil(view.content.length / toolPageStride) - 1),
        view.page + direction,
      ),
    );
    setArtifacts((previous) => ({ ...previous, [id]: { ...view, page } }));
  }
  return {
    messages,
    visibleMessages,
    session,
    plan,
    revealPlan: () => {
      const id = messages()
        .filter((message) => message.id.startsWith("plan:"))
        .at(-1)?.id;
      if (id) {
        setSelected(id);
        setReveal(id);
      }
    },
    phase,
    selected,
    expandedReasoning,
    expandedTools,
    artifacts,
    canReadArtifact: !!readArtifact,
    openArtifact,
    changeArtifactPage,
    toggleDetails,
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
