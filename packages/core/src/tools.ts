import Ajv from "ajv";
import type {
  PermissionMode,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolSchema,
} from "./contracts.ts";
import { estimateTokens } from "./context.ts";

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
    if (!tool) throw new Error(`Unknown tool ${call.name}; discover it with tools_search.`);
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
      throw new Error(
        `Invalid arguments for ${call.name}: ${this.ajv.errorsText(validate.errors)}${hints.length ? "; " + hints.join("; ") : ""}. No tool was executed. Correct the arguments before retrying; use tools_search to inspect the schema. Do not repeat an unchanged invalid call.`,
      );
    }
    return tool;
  }
}

export class PermissionGate {
  constructor(
    readonly mode: PermissionMode,
    private readonly approve?: (
      tool: ToolDefinition,
      args: Record<string, unknown>,
    ) => Promise<boolean>,
  ) {}
  async authorize(tool: ToolDefinition, args: Record<string, unknown>): Promise<void> {
    if (tool.kind === "read" || this.mode === "yolo") return;
    if (this.mode === "read-only") throw new Error(`Read-only mode denies ${tool.name}.`);
    if (!this.approve || !(await this.approve(tool, args)))
      throw new Error(`Approval denied for ${tool.name}.`);
  }
}
