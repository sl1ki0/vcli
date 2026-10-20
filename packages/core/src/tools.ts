import Ajv, { type ErrorObject } from "ajv";
import type {
  ApprovalDecision,
  PermissionMode,
  Session,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolSchema,
} from "./contracts.ts";
import { estimateTokens } from "./context.ts";
import { PendingApprovalError } from "./run-state.ts";

/** Schema-only fingerprint: never includes the supplied argument values. */
function validationSignatures(errors: ErrorObject[]): string[] {
  return [
    ...new Set(
      errors.map((error) =>
        JSON.stringify({
          path: error.instancePath,
          schema: error.schemaPath,
          keyword: error.keyword,
          expected: Object.fromEntries(
            Object.entries(error.params)
              .filter(([key]) => key !== "additionalProperty" && key !== "propertyName")
              .sort(([left], [right]) => left.localeCompare(right)),
          ),
        }),
      ),
    ),
  ].sort();
}

export class ToolValidationError extends Error {
  constructor(
    message: string,
    readonly signatures: string[],
  ) {
    super(message);
    this.name = "ToolValidationError";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly active = new Set<string>();
  private readonly validators = new Map<string, ReturnType<Ajv["compile"]>>();
  private readonly ajv = new Ajv({ strict: false, allErrors: true });
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.validators.set(tool.name, this.ajv.compile(tool.inputSchema));
    this.tools.set(tool.name, tool);
  }
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }
  activate(names: string[]): void {
    for (const name of names) if (this.tools.has(name)) this.active.add(name);
  }
  search(query: string, limit = 5): ToolSchema[] {
    const words = query.toLowerCase().split(/\W+/).filter(Boolean);
    return [...this.tools.values()]
      .map((t) => ({
        t,
        score: words.reduce(
          (n, word) => n + (`${t.name} ${t.description}`.toLowerCase().includes(word) ? 1 : 0),
          0,
        ),
      }))
      .filter(({ score }) => score > 0 || !words.length)
      .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
      .slice(0, limit)
      .map(({ t }) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }
  schemas(budget: number, eagerOnly = false): ToolSchema[] {
    const selected: ToolSchema[] = [];
    let cost = 0;
    const candidates = [...this.tools.values()]
      .filter((t) => t.eager || (!eagerOnly && this.active.has(t.name)))
      .sort(
        (a, b) =>
          Number(Boolean(b.eager)) - Number(Boolean(a.eager)) || a.name.localeCompare(b.name),
      );
    for (const t of candidates) {
      const schema = { name: t.name, description: t.description, inputSchema: t.inputSchema };
      const size = estimateTokens(JSON.stringify(schema));
      if (cost + size <= budget) {
        selected.push(schema);
        cost += size;
      } else if (t.eager)
        throw new Error(`Eager tool schemas exceed ${budget} tokens; increase schemaTokens.`);
    }
    return selected;
  }
  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    return this.executeWith(call, context, (execute) => execute());
  }
  async executeWith(
    call: ToolCall,
    context: ToolContext,
    around: (execute: () => Promise<ToolResult>) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const tool = this.validate(call);
    context.signal.throwIfAborted();
    return around(() => tool.execute(call.arguments, context));
  }
  /** Check provider input before asking the user or recording an execution start. */
  validate(call: ToolCall): ToolDefinition {
    const tool = this.tools.get(call.name);
    if (!tool)
      throw new ToolValidationError(`Unknown tool ${call.name}; discover it with tools_search.`, [
        "unknown-tool",
      ]);
    const validate = this.validators.get(call.name)!;
    if (!validate(call.arguments)) {
      const hints = (validate.errors ?? []).slice(0, 5).flatMap((error) => {
        if (error.keyword !== "const" && error.keyword !== "type") return [];
        let actual: unknown = call.arguments;
        for (const segment of error.instancePath.split("/").slice(1)) {
          const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
          actual =
            actual !== null && typeof actual === "object" && Object.hasOwn(actual, key)
              ? (actual as Record<string, unknown>)[key]
              : undefined;
        }
        const expected =
          error.keyword === "type"
            ? String(error.params.type)
            : `constant ${typeof error.params.allowedValue === "object" ? "(fixed value)" : JSON.stringify(error.params.allowedValue)}`;
        const received = actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual;
        return [`${error.instancePath || "/"}: expected ${expected}; received ${received}`];
      });
      throw new ToolValidationError(
        `Invalid arguments for ${call.name}: ${this.ajv.errorsText(validate.errors)}${hints.length ? "; " + hints.join("; ") : ""}. No tool was executed. Correct the arguments before retrying; use tools_search to inspect the schema. Do not repeat an unchanged invalid call.`,
        validationSignatures(validate.errors ?? []),
      );
    }
    return tool;
  }
}

export class PermissionGate {
  private binding?: { session: Session; save: () => Promise<void> };
  private authorization = Promise.resolve();
  private modeChange = new AbortController();
  constructor(
    private currentMode: PermissionMode,
    private readonly approve?: (
      tool: ToolDefinition,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<ApprovalDecision>,
  ) {}
  get mode(): PermissionMode {
    return this.currentMode;
  }
  /** Re-evaluate pending approvals without replaying or interrupting executed tools. */
  setMode(mode: PermissionMode): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    const previous = this.modeChange;
    this.modeChange = new AbortController();
    previous.abort();
  }
  /** Refresh for every run; durable grants are scoped to this session and project. */
  bindSession(session: Session, save: () => Promise<void>): void {
    this.binding = { session, save };
  }
  async authorize(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    callId?: string,
    force = false,
  ): Promise<void> {
    if (tool.kind === "read") return;
    const saved = callId && this.binding?.session.runState?.calls[callId];
    if (saved && saved.approval?.decision === false)
      throw new Error(`Approval denied for ${tool.name}.`);
    this.checkPolicy(tool, this.binding);
    if (this.mode === "yolo" && !force) return;
    const binding = this.binding;
    // A grant cannot become usable while its persistence is still in flight.
    const result = this.authorization.then(() =>
      this.authorizeAsk(tool, args, binding, callId, force),
    );
    this.authorization = result.catch(() => {});
    return result;
  }
  /** Cheap live-policy recheck immediately before the executor crosses its effect boundary. */
  assertAllowed(tool: ToolDefinition): void {
    if (tool.kind !== "read") this.checkPolicy(tool, this.binding);
  }
  private checkPolicy(tool: ToolDefinition, binding: typeof this.binding): void {
    if (this.mode === "read-only") throw new Error(`Read-only mode denies ${tool.name}.`);
    if (binding?.session.mode === "plan")
      throw new Error(`Plan mode denies ${tool.name}. Switch to build mode to implement.`);
  }
  private async authorizeAsk(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    binding: typeof this.binding,
    callId?: string,
    force = false,
  ): Promise<void> {
    if (this.binding !== binding) throw new Error("Approval session changed. Retry the request.");
    this.checkPolicy(tool, binding);
    if (this.mode === "yolo" && !force) return;
    const contract = () =>
      JSON.stringify({
        name: tool.name,
        kind: tool.kind,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    const schema = contract();
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(schema)),
    );
    if (this.binding !== binding) throw new Error("Approval session changed. Retry the request.");
    this.checkPolicy(tool, binding);
    if (this.currentMode === "yolo" && !force) return;
    const schemaDigest = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const grant = binding && {
      sessionId: binding.session.id,
      root: binding.session.root,
      name: tool.name,
      kind: tool.kind,
      schemaDigest,
    };
    if (
      !force &&
      grant &&
      binding.session.toolApprovals?.some(
        (saved) =>
          saved.sessionId === grant.sessionId &&
          saved.root === grant.root &&
          saved.name === grant.name &&
          saved.kind === grant.kind &&
          saved.schemaDigest === grant.schemaDigest,
      )
    )
      return;
    const entry = callId && binding?.session.runState?.calls[callId];
    if (entry && entry.approval?.schemaDigest && entry.approval.schemaDigest !== schemaDigest)
      throw new Error(`Tool contract changed for ${tool.name}. Request approval again.`);
    const savedDecision = entry ? entry.approval?.decision : undefined;
    if (entry && savedDecision === undefined) {
      entry.status = "approval";
      entry.approval = { schemaDigest };
      await binding!.save();
      if (!this.approve) throw new PendingApprovalError(callId!);
    }
    const change = this.modeChange.signal;
    let onChange!: () => void;
    const modeChanged = new Promise<undefined>((resolve) => {
      onChange = () => resolve(undefined);
      change.addEventListener("abort", onChange, { once: true });
    });
    let decision: ApprovalDecision | undefined;
    try {
      decision =
        savedDecision ?? (await Promise.race([this.approve?.(tool, args, change), modeChanged]));
    } finally {
      change.removeEventListener("abort", onChange);
    }
    // The UI may resolve its canceled card before the mode-change race settles.
    if (change.aborted) {
      if (entry) {
        entry.status = "reserved";
        await binding!.save();
      }
      return this.authorizeAsk(tool, args, binding, callId, force);
    }
    if (entry) {
      entry.approval = {
        decision: decision ?? false,
        decidedAt: new Date().toISOString(),
        schemaDigest,
      };
      entry.status = "reserved";
      await binding!.save();
    }
    if (decision !== true && decision !== "always")
      throw new Error(`Approval denied for ${tool.name}.`);
    if (this.binding !== binding) throw new Error("Approval session changed. Retry the request.");
    this.checkPolicy(tool, binding);
    if (contract() !== schema)
      throw new Error(`Tool contract changed for ${tool.name}. Request approval again.`);
    if (decision === true || force) return;
    // Standalone gates cannot turn a conversation choice into a process-wide grant.
    if (!binding || !grant)
      throw new Error(`Cannot remember approval for ${tool.name} without a bound conversation.`);
    const previous = binding.session.toolApprovals;
    binding.session.toolApprovals = [...(previous ?? []), grant];
    try {
      await binding.save();
    } catch (error) {
      binding.session.toolApprovals = previous;
      throw new Error(`Could not save approval for ${tool.name}; no tool was executed.`, {
        cause: error,
      });
    }
    if (this.binding !== binding) throw new Error("Approval session changed. Retry the request.");
    this.checkPolicy(tool, binding);
  }
}
