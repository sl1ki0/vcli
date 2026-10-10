import type { ArchitectureGraph, ArchitectureService, ContextSettings, Message, ProviderAdapter, RuntimeEvent, Session, SessionStore, ToolCall, ToolResult, Usage } from "./contracts.ts";
import { balanced, boundText, BudgetContextPlanner, estimateTokens } from "./context.ts";
import { PermissionGate, ToolRegistry } from "./tools.ts";

export interface RuntimeOptions {
  root: string; provider: ProviderAdapter; tools: ToolRegistry; architecture: ArchitectureService;
  store: SessionStore; permissions: PermissionGate; settings?: Partial<ContextSettings>;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
}
export class AgentRuntime {
  readonly settings: ContextSettings;
  private session?: Session;
  private readonly readSpans = new Map<string, { revision: string; lines: Map<number, string> }>();
  constructor(private readonly options: RuntimeOptions) { this.settings = { ...balanced, ...options.settings }; }
  get currentSession(): Session | undefined { return this.session; }
  private async emit(type: RuntimeEvent["type"], data: Record<string, unknown>): Promise<void> {
    const event: RuntimeEvent = { type, data, sessionId: this.session!.id, time: new Date().toISOString() };
    await this.options.store.append(event);
    await this.options.onEvent?.(event);
  }
  async record(values: { decisions?: string[]; constraints?: string[]; pending?: string[]; verification?: string[] }): Promise<void> {
    if (!this.session) throw new Error("No active session");
    const ledger = this.session.ledger;
    for (const key of ["decisions", "constraints", "verification"] as const) if (values[key]) ledger[key] = [...new Set([...ledger[key], ...values[key]!])];
    if (values.pending) ledger.pending = values.pending;
    await this.options.store.save(this.session);
  }
  async run(prompt: string, signal: AbortSignal, resumeId?: string): Promise<Session> {
    this.readSpans.clear();
    const { root, provider, store, architecture, tools } = this.options;
    this.session = resumeId ? await store.get(resumeId) : await store.create(root, provider, prompt);
    if (!this.session) throw new Error(`Session not found: ${resumeId}`);
    const session = this.session;
    if (session.root !== root) throw new Error("Session belongs to a different project.");
    if (session.provider !== provider.id || session.model !== provider.model) {
      session.messages = session.messages.map(m => ({ ...m, providerData: undefined }));
      session.provider = provider.id; session.model = provider.model;
    }
    session.status = "running";
    if (prompt) session.messages.push({ role: "user", text: prompt });
    await store.save(session);
    await this.emit("session", { id: session.id, mode: this.options.permissions.mode, goal: session.ledger.goal });
    let graph: ArchitectureGraph;
    try {
      graph = await architecture.scan(root);
      const uncertain = await store.pendingMutations(session.id);
      for (const name of uncertain) session.ledger.constraints.push(`Previous ${name} has an uncertain outcome. Inspect state before any related action; do not replay it.`);
      // Close unfinished call groups without repeating their effects.
      const completed = new Set(session.messages.filter(m => m.role === "tool").map(m => m.toolCallId));
      for (const m of [...session.messages]) for (const call of m.toolCalls ?? []) if (!completed.has(call.id)) session.messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, text: "Interrupted before a recorded result. Outcome uncertain; inspect current state. Do not replay automatically." });
      await this.emit("architecture", { revision: graph.revision, graph });
      for (let turn = 0; turn < this.settings.maxTurns; turn++) {
        signal.throwIfAborted();
        const request = new BudgetContextPlanner().build(session, graph, tools.schemas(this.settings.schemaTokens), this.settings, provider.contextWindow);
        const inputEstimate = estimateTokens(request.system + JSON.stringify(request.messages) + JSON.stringify(request.tools));
        if (this.settings.taskTokens !== undefined) {
          const remaining = this.settings.taskTokens - session.usage.input - session.usage.output;
          if (remaining < inputEstimate + 256) { session.status = "budget"; break; }
          request.maxOutputTokens = Math.min(request.maxOutputTokens, remaining - inputEstimate);
        }
        if (request.messages.length < session.messages.length) await this.emit("compaction", { retained: request.messages.length, total: session.messages.length, ledgerPreserved: true });
        let text = ""; const calls: ToolCall[] = []; let providerData: unknown;
        let usage: Usage = { input: 0, output: 0, cached: 0 };
        for await (const event of provider.stream(request, signal)) {
          if (event.type === "text") { text += event.text; await this.emit("text", { text: event.text }); }
          if (event.type === "tool-call") calls.push(event.call);
          if (event.type === "usage") usage = event.usage;
          if (event.type === "done") providerData = event.providerData;
        }
        session.usage.input += usage.input; session.usage.output += usage.output; session.usage.cached += usage.cached;
        const assistant: Message = { role: "assistant", text, providerData, ...(calls.length ? { toolCalls: calls } : {}) };
        session.messages.push(assistant);
        await store.save(session);
        await this.emit("usage", { usage, total: session.usage });
        if (!calls.length) { session.status = "complete"; break; }
        const execute = async (call: ToolCall): Promise<{ call: ToolCall; result: ToolResult }> => {
          const tool = tools.get(call.name);
          try {
            if (!tool) throw new Error(`Unknown tool: ${call.name}`);
            await this.options.permissions.authorize(tool, call.arguments);
            // Durable start precedes the side effect.
            await this.emit("tool-start", { callId: call.id, name: call.name, kind: tool.kind, arguments: call.arguments });
            const result = await tools.execute(call, { root, signal, sessionId: session.id });
            return { call, result };
          } catch (error) {
            if (signal.aborted) throw error;
            return { call, result: { text: error instanceof Error ? error.message : String(error), isError: true } };
          }
        };
        let mutated = false;
        const recordResult = async ({ call, result }: { call: ToolCall; result: ToolResult }) => {
          const full = result.fullOutput ?? result.text;
          const artifact = await store.putArtifact(session.id, full);
          let content = result.text;
          const details = result.details as { sourcePath?: string; revision?: string } | undefined;
          if (call.name === "files_read" && details?.sourcePath && details.revision && result.fullOutput) {
            let known = this.readSpans.get(details.sourcePath);
            if (!known || known.revision !== details.revision) { known = { revision: details.revision, lines: new Map() }; this.readSpans.set(details.sourcePath, known); }
            const fresh: string[] = []; const prior = new Set<string>();
            for (const line of full.split("\n")) {
              const number = Number(line.match(/^(\d+): /)?.[1]);
              if (!number) { fresh.push(line); continue; }
              const handle = known.lines.get(number);
              if (handle) prior.add(handle); else fresh.push(line);
              known.lines.set(number, artifact);
            }
            if (prior.size) content = `${details.sourcePath}\n${fresh.join("\n")}\nUnchanged overlapping lines omitted; earlier artifacts: ${[...prior].slice(0, 8).join(", ")}. Retrieve this result for the complete requested span.`;
          }
          const output = `${boundText(content, this.settings.resultTokens)}\nFull result: ${artifact}`;
          session.messages.push({ role: "tool", text: output, toolCallId: call.id, toolName: call.name });
          session.ledger.touchedPaths = [...new Set([...session.ledger.touchedPaths, ...result.changedPaths ?? []])];
          if (call.name === "shell_run") session.ledger.verification.push(boundText(result.text, 400));
          mutated ||= tools.get(call.name)?.kind !== "read";
          await store.save(session);
          await this.emit("tool-end", { callId: call.id, name: call.name, result: output, artifact, isError: result.isError ?? false, details: result.details, changedPaths: result.changedPaths });
        };
        // Read batches may run concurrently; writes and arbitrary shell effects form barriers.
        for (let i = 0; i < calls.length;) {
          if (tools.get(calls[i]!.name)?.kind === "read") {
            const reads: ToolCall[] = [];
            while (i < calls.length && reads.length < 4 && tools.get(calls[i]!.name)?.kind === "read") reads.push(calls[i++]!);
            for (const result of await Promise.all(reads.map(execute))) await recordResult(result);
          } else await recordResult(await execute(calls[i++]!));
        }
        if (mutated) { graph = await architecture.scan(root); await this.emit("architecture", { graph, revision: graph.revision }); }
        if (turn === this.settings.maxTurns - 1) session.status = "budget";
      }
    } catch (error) {
      session.status = signal.aborted ? "aborted" : "failed";
      await this.emit("status", { status: session.status, error: error instanceof Error ? error.message : String(error) });
      await store.save(session);
      if (!signal.aborted) throw error;
    }
    await store.save(session);
    await this.emit("status", { status: session.status });
    return session;
  }
}
