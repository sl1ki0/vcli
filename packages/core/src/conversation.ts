import type { ChatMessage, RuntimeEvent, Session } from "./contracts.ts";

/** Human chat never participates in model context selection or compaction. */
export function conversation(session: Session): ChatMessage[] {
  return (session.chat ??= session.messages.flatMap((message, index) =>
    (message.role === "user" || message.role === "assistant") && message.text
      ? [
          {
            id: `legacy:${session.id}:${index}`,
            role: message.role,
            text: message.text,
            createdAt: session.createdAt,
            status: "complete" as const,
          },
        ]
      : [],
  ));
}

export function startMessage(session: Session, role: ChatMessage["role"], text = ""): ChatMessage {
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
    status: role === "user" ? "complete" : "streaming",
  };
  conversation(session).push(message);
  return message;
}

/** Replays only append-only conversation events after a persisted snapshot. */
export function applyConversationEvent(chat: ChatMessage[], event: RuntimeEvent): void {
  const id = event.data.messageId;
  if (typeof id !== "string") return;
  let message = chat.find((item) => item.id === id);
  if (event.type === "message-start" && !message) {
    const role = event.data.role;
    if (role !== "user" && role !== "assistant") return;
    message = {
      id,
      role,
      text: typeof event.data.text === "string" ? event.data.text : "",
      createdAt: typeof event.data.createdAt === "string" ? event.data.createdAt : event.time,
      status: role === "user" ? "complete" : "streaming",
    };
    chat.push(message);
  }
  if (!message) return;
  if (event.type === "text" && typeof event.data.text === "string") message.text += event.data.text;
  if (event.type === "reasoning" && typeof event.data.text === "string")
    message.reasoning = (message.reasoning ?? "") + event.data.text;
  if (event.type === "message-end") {
    const status = event.data.status;
    if (status === "complete" || status === "failed" || status === "aborted")
      message.status = status;
  }
}

/** Older releases recorded text deltas but had no message identifiers. */
export function recoverLegacyConversation(session: Session, events: RuntimeEvent[]): void {
  const saved = session.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text);
  let text = "";
  let createdAt = session.createdAt;
  let index = 0;
  const flush = (completed: boolean) => {
    if (!text) return;
    const match = saved.indexOf(text);
    if (match >= 0) saved.splice(match, 1);
    else
      conversation(session).push({
        id: `legacy-event:${session.id}:${index++}`,
        role: "assistant",
        text,
        createdAt,
        status: completed ? "complete" : session.status === "failed" ? "failed" : "aborted",
      });
    text = "";
  };
  for (const event of events) {
    if (
      event.type === "text" &&
      typeof event.data.messageId !== "string" &&
      typeof event.data.text === "string"
    ) {
      if (!text) createdAt = event.time;
      text += event.data.text;
    } else if (event.type === "usage") flush(true);
    else if (event.type === "status" || event.type === "session") flush(false);
  }
  flush(false);
}
