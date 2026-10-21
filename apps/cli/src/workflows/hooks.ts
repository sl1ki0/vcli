import { executeProcess } from "./process.ts";
import { RootedFileSystem } from "./rooted-filesystem.ts";
import type { PermissionGate } from "@vcli/core";
import { type ToolCall, type ToolContext, type ToolDefinition, type ToolResult } from "@vcli/core";

export type HookEvent = "beforeTool" | "afterTool";
export interface CommandHook {
  name: string;
  command: string;
  tools: string[];
  timeoutMs: number;
}
export interface HookReport {
  name: string;
  event: HookEvent;
  status: "success" | "failed" | "denied" | "timeout" | "aborted";
  output: string;
  truncated?: boolean;
}
type HookConfig = Record<HookEvent, CommandHook[]>;
const OUTPUT_BYTES = 16_384;
const CONFIG_BYTES = 65_536;

export class HookBlockedError extends Error {
  constructor(readonly reports: HookReport[]) {
    const last = reports.at(-1)!;
    super(`Hook ${last.name} blocked the tool (${last.status}): ${last.output}`);
    this.name = "HookBlockedError";
  }
}

function parseHooks(raw: unknown): HookConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Expected a hooks object.");
  const config = raw as Record<string, unknown>;
  if (config.version !== 1) throw new Error("hooks.json requires version: 1.");
  if (Object.keys(config).some((key) => !["version", "beforeTool", "afterTool"].includes(key)))
    throw new Error("Unknown hooks.json field; supported events are beforeTool and afterTool.");
  const result: HookConfig = { beforeTool: [], afterTool: [] };
  for (const event of ["beforeTool", "afterTool"] as const) {
    const entries = config[event] ?? [];
    if (!Array.isArray(entries) || entries.length > 20)
      throw new Error(`${event} must be an array of at most 20 hooks.`);
    const names = new Set<string>();
    result[event] = entries.map((value): CommandHook => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Invalid ${event} hook.`);
      const hook = value as Record<string, unknown>;
      if (Object.keys(hook).some((key) => !["name", "command", "tools", "timeoutMs"].includes(key)))
        throw new Error(`Unknown ${event} hook field.`);
      if (
        typeof hook.name !== "string" ||
        !/^[\w.-]{1,80}$/.test(hook.name) ||
        names.has(hook.name)
      )
        throw new Error(`Hook names must be unique identifiers within ${event}.`);
      names.add(hook.name);
      if (typeof hook.command !== "string" || !hook.command.trim() || hook.command.length > 4096)
        throw new Error(`Hook ${hook.name} needs a command of at most 4096 characters.`);
      const tools = hook.tools ?? ["*"];
      if (
        !Array.isArray(tools) ||
        !tools.length ||
        tools.length > 100 ||
        tools.some((tool) => typeof tool !== "string" || !/^(\*|[\w.-]{1,160})$/.test(tool))
      )
        throw new Error(`Hook ${hook.name} tools must be exact tool names or *.`);
      const timeoutMs = hook.timeoutMs ?? 10_000;
      if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 10 || Number(timeoutMs) > 120_000)
        throw new Error(`Hook ${hook.name} timeoutMs must be between 10 and 120000.`);
      return {
        name: hook.name,
        command: hook.command,
        tools: tools as string[],
        timeoutMs: Number(timeoutMs),
      };
    });
  }
  return result;
}

async function executeHook(
  hook: CommandHook,
  event: HookEvent,
  payload: string,
  context: ToolContext,
): Promise<HookReport> {
  context.signal.throwIfAborted();
  const result = await executeProcess("/bin/sh", ["-c", hook.command], context, hook.timeoutMs, {
    access: "write",
    outputLimitBytes: OUTPUT_BYTES,
    stdin: (root) => {
      const input = JSON.parse(payload) as Record<string, unknown>;
      input.root = root;
      return JSON.stringify(input);
    },
  });
  let output = Buffer.from(result.output).subarray(0, OUTPUT_BYTES).toString("utf8");
  while (Buffer.byteLength(output) > OUTPUT_BYTES) output = output.slice(0, -1);
  return {
    name: hook.name,
    event,
    status: result.timedOut ? "timeout" : result.code === 0 ? "success" : "failed",
    output,
    truncated: result.truncated || output !== result.output,
  };
}

/** Commands are local vcli hooks, not compatible with vendor-specific hook protocols. */
export class ProjectHooks {
  constructor(
    private readonly config: HookConfig,
    private readonly permissions: PermissionGate,
    private readonly preflight?: (command: string, context: ToolContext) => Promise<void>,
  ) {}

  get hasHooks(): boolean {
    return this.config.beforeTool.length > 0 || this.config.afterTool.length > 0;
  }

  effects(call: ToolCall): { name: string; event: HookEvent; command: string }[] {
    return (["beforeTool", "afterTool"] as const).flatMap((event) =>
      this.config[event]
        .filter((hook) => hook.tools.includes("*") || hook.tools.includes(call.name))
        .map(({ name, command }) => ({ name, event, command })),
    );
  }

  async beforeTool(call: ToolCall, context: ToolContext): Promise<HookReport[]> {
    return this.run("beforeTool", call, context);
  }

  /** Failures remain reports so they cannot turn an already completed mutation into a retry. */
  async afterTool(call: ToolCall, result: ToolResult, context: ToolContext): Promise<HookReport[]> {
    return this.run("afterTool", call, context, result);
  }

  private async run(
    event: HookEvent,
    call: ToolCall,
    context: ToolContext,
    result?: ToolResult,
  ): Promise<HookReport[]> {
    const reports: HookReport[] = [];
    for (const hook of this.config[event]) {
      if (!hook.tools.includes("*") && !hook.tools.includes(call.name)) continue;
      const tool: ToolDefinition = {
        name: `hook.${event}.${hook.name}`,
        description: `Run project hook ${hook.name}`,
        kind: "execute",
        inputSchema: {},
        execute: async () => ({ text: "Hook executed" }),
      };
      let report: HookReport;
      try {
        await this.preflight?.(hook.command, context);
        if (context.effectsAuthorized) this.permissions.assertAllowed(tool);
        else
          await this.permissions.authorize(tool, { command: hook.command, tool: call.name, event });
        // Deliberately omit full artifacts and UI details from hook input.
        const payload = JSON.stringify({
          version: 1,
          event,
          sessionId: context.sessionId,
          root: context.root,
          tool: call,
          result: result && {
            text: result.text,
            isError: result.isError,
            changedPaths: result.changedPaths,
          },
        });
        report = await executeHook(hook, event, payload, context);
      } catch (error) {
        report = {
          name: hook.name,
          event,
          status: context.signal.aborted ? "aborted" : "denied",
          output: error instanceof Error ? error.message : String(error),
        };
      }
      reports.push(report);
      if (event === "beforeTool" && report.status !== "success")
        throw new HookBlockedError(reports);
      if (context.signal.aborted) break;
    }
    return reports;
  }
}

/** Invalid config fails closed: configured checks must never silently disappear. Reload per run. */
export async function loadProjectHooks(
  root: string,
  permissions: PermissionGate,
  preflight?: (command: string, context: ToolContext) => Promise<void>,
): Promise<ProjectHooks> {
  using filesystem = new RootedFileSystem(root, { allowProtectedPaths: true });
  const snapshot = filesystem.snapshot(".vcli/hooks.json", CONFIG_BYTES + 1);
  if (!snapshot) return new ProjectHooks({ beforeTool: [], afterTool: [] }, permissions, preflight);
  if (snapshot.content.byteLength > CONFIG_BYTES) throw new Error("hooks.json exceeds 64 KiB.");
  return new ProjectHooks(
    parseHooks(JSON.parse(snapshot.content.toString("utf8"))),
    permissions,
    preflight,
  );
}
