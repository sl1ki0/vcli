import { randomUUID } from "node:crypto";
import {
  boundText,
  type AgentRuntime,
  type ContextSettings,
  type RuntimeEvent,
  type Session,
  type RunLimits,
} from "@vcli/core";

export interface DelegationReservation {
  tokens: number;
  runLimits?: RunLimits;
  /** Missing usage keeps a conservative charge; settlement must be durable and idempotent. */
  settle(session?: Session): Promise<void>;
}
export interface SubagentUpdate {
  id: string;
  parentSessionId: string;
  status: "running" | Session["status"];
  sessionId?: string;
  event?: RuntimeEvent;
}
export interface SubagentOptions {
  /** The factory must use a fresh runtime with only local read tools, no shell or delegation. */
  createRuntime(options: {
    settings: Partial<ContextSettings>;
    runLimits?: RunLimits;
    onEvent(event: RuntimeEvent): Promise<void>;
  }): Pick<AgentRuntime, "run" | "currentSession">;
  reserve(parentSessionId: string, tokens: number): Promise<DelegationReservation>;
  onEvent?(update: SubagentUpdate): void | Promise<void>;
}
export interface SubagentResult {
  id: string;
  sessionId?: string;
  status: Session["status"];
  summary: string;
  transcript: string;
}

/** Awaited explorers have independent context, bounded cost, and a shared cancellation signal. */
export class SubagentService {
  private active = 0;
  constructor(private readonly options: SubagentOptions) {}

  async explore(
    prompt: string,
    parentSessionId: string,
    signal: AbortSignal,
    tokens = 12000,
  ): Promise<SubagentResult> {
    if (!prompt.trim() || prompt.length > 16000)
      throw new Error("Explorer task must contain 1–16,000 characters.");
    if (!Number.isInteger(tokens) || tokens < 4000 || tokens > 24000)
      throw new Error("Explorer token allocation must be 4,000–24,000.");
    signal.throwIfAborted();
    if (this.active >= 2)
      throw new Error(
        "Two explorers are already running. Wait for a result before delegating again.",
      );
    this.active++;
    let reservation: DelegationReservation | undefined;
    let runtime: ReturnType<SubagentOptions["createRuntime"]> | undefined;
    const id = randomUUID();
    let failure: unknown;
    try {
      reservation = await this.options.reserve(parentSessionId, tokens);
      signal.throwIfAborted();
      runtime = this.options.createRuntime({
        runLimits: reservation.runLimits,
        settings: {
          taskTokens: reservation.tokens,
          promptTokens: 8000,
          mapTokens: 1000,
          schemaTokens: 1800,
          resultTokens: 1200,
          outputTokens: 2000,
          maxTurns: 6,
        },
        onEvent: async (event) => {
          await this.options.onEvent?.({
            id,
            parentSessionId,
            sessionId: event.sessionId,
            status: "running",
            event,
          });
        },
      });
      await this.options.onEvent?.({ id, parentSessionId, status: "running" });
      await runtime.run(
        [
          "You are a read-only explorer delegated one bounded task. Do not change files, run shell commands, or delegate again.",
          "Inspect relevant source and return concise findings with file/line evidence, uncertainty, and recommended next steps. Report incomplete work honestly.",
          "Delegated task:",
          prompt,
        ].join("\n\n"),
        signal,
      );
    } catch (error) {
      failure = error;
    } finally {
      try {
        await reservation?.settle(runtime?.currentSession);
      } finally {
        this.active--;
      }
    }
    const session = runtime?.currentSession;
    const status = failure
      ? signal.aborted
        ? "aborted"
        : "failed"
      : (session?.status ?? "failed");
    await this.options.onEvent?.({ id, parentSessionId, sessionId: session?.id, status });
    signal.throwIfAborted();
    const response = session?.messages
      .filter((message) => message.role === "assistant" && message.text.trim())
      .at(-1)?.text;
    const errorText =
      failure instanceof Error ? failure.message : failure ? String(failure) : undefined;
    const summary = boundText(
      [
        `Explorer ${id}: ${status}. Child session: ${session?.id ?? "not created"}.`,
        response ?? "No findings returned.",
        ...(errorText ? [`Error: ${errorText}`] : []),
      ].join("\n\n"),
      1800,
    );
    return {
      id,
      sessionId: session?.id,
      status,
      summary,
      transcript: JSON.stringify(
        {
          id,
          parentSessionId,
          sessionId: session?.id,
          status,
          error: errorText,
          messages: session?.messages ?? [],
        },
        null,
        2,
      ),
    };
  }
}
