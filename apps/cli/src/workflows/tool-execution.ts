import type { PermissionGate, ToolCall, ToolContext, ToolRegistry, ToolResult } from "@vcli/core";
import { CheckpointService } from "./checkpoints.ts";
import { loadProjectHooks, type ProjectHooks } from "./hooks.ts";
import { RunJournal } from "./journal.ts";
import { ProjectPolicy } from "./policy.ts";

interface ProjectToolExecutionOptions {
  root: string;
  registry: ToolRegistry;
  permissions: PermissionGate;
  policyPath?: string;
  stateDirectory?: string;
  externalStartup?: () => { count: number; description: string };
}
const isPlanMetadata = (call: ToolCall): boolean =>
  ["plan_publish", "plan_task"].includes(call.name);

/** Owns the local execution boundary: policy, command hooks, checkpoints and run-wide recovery. */
export class ProjectToolExecutor {
  readonly journal: RunJournal;
  readonly checkpoints: CheckpointService;

  private constructor(
    private readonly options: ProjectToolExecutionOptions,
    readonly policy: ProjectPolicy,
    private hooks: ProjectHooks,
  ) {
    this.journal = new RunJournal(options.root, { ...options, policy });
    this.checkpoints = new CheckpointService(options.root);
  }

  static async create(options: ProjectToolExecutionOptions): Promise<ProjectToolExecutor> {
    const policy = await ProjectPolicy.load(options.root, options.policyPath, options);
    const hooks = await loadProjectHooks(options.root, options.permissions, async (command) => {
      await policy.assertCommand(command);
    });
    return new ProjectToolExecutor(options, policy, hooks);
  }

  async reloadHooks(): Promise<void> {
    this.hooks = await loadProjectHooks(
      this.options.root,
      this.options.permissions,
      async (command) => {
        await this.policy.assertCommand(command);
      },
    );
  }

  private extraEffects(call: ToolCall): { count: number; description: string } {
    if (isPlanMetadata(call)) return { count: 0, description: "" };
    const effects = this.hooks.effects(call);
    const startup = call.name === "tools_search" ? this.options.externalStartup?.() : undefined;
    return {
      count: effects.length + (startup?.count ?? 0),
      description: [
        ...effects.map((hook) => `${hook.event} hook ${hook.name}: ${hook.command}`),
        ...(startup?.count ? [startup.description] : []),
      ].join("\n"),
    };
  }

  readonly serialTools = (): boolean => this.hooks.hasHooks;

  readonly sideEffectCost = (call: ToolCall): number =>
    Number(this.options.registry.get(call.name)?.kind !== "read") + this.extraEffects(call).count;

  readonly beforeTool = async (call: ToolCall, context: ToolContext): Promise<void> => {
    await this.policy.assertTool(call, context);
    context.authorizePath = (path, write) =>
      this.policy.resolvePath(path, { write, allowRoot: true });
    context.effectSummary = this.extraEffects(call).description;
    if (
      this.policy.requiresApproval(call) ||
      this.hooks.effects(call).some((hook) =>
        this.policy.requiresApproval({
          id: call.id,
          name: "shell_run",
          arguments: { command: hook.command },
        }),
      )
    )
      context.requireApproval = true;
  };

  readonly inspectUncertain = (call: ToolCall, context: ToolContext): Promise<string> =>
    this.journal.inspectUncertain(context.sessionId, call.id);

  readonly executeTool = async (
    call: ToolCall,
    context: ToolContext,
    execute: () => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    // Plan metadata is durable but cannot invoke project command hooks.
    if (isPlanMetadata(call)) return execute();
    const token = await this.journal.before(call, context, {
      force:
        this.extraEffects(call).count > 0 || this.options.registry.get(call.name)?.kind !== "read",
    });
    let result: ToolResult;
    try {
      result = await this.executeWithHooks(call, context, execute);
    } catch (error) {
      try {
        await this.journal.after(token);
      } catch {
        return {
          text: `${error instanceof Error ? error.message : String(error)}\nJournal finalization failed. Inspect the uncertain action before continuing.`,
          isError: true,
          outcomeUncertain: true,
        };
      }
      throw error;
    }
    try {
      await this.journal.after(token);
      return result;
    } catch {
      return this.withWarnings(
        result,
        [
          "The tool finished, but journal finalization failed. Inspect and resolve this action before continuing; do not replay it.",
        ],
        true,
      );
    }
  };

  private async executeWithHooks(
    call: ToolCall,
    context: ToolContext,
    execute: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    await this.hooks.beforeTool(call, context);
    const checkpoint = await this.checkpoints.before(call, context);
    let result: ToolResult;
    try {
      result = await execute();
    } catch (error) {
      await this.checkpoints.after(checkpoint).catch(() => {});
      if (checkpoint)
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nFile mutation outcome may be uncertain. Inspect the file and checkpoint before retrying; do not replay automatically.`,
        );
      throw error;
    }
    const warnings = await this.finalizeCheckpoint(checkpoint, result);
    const reports = await this.hooks.afterTool(call, result, context);
    for (const report of reports)
      if (report.status !== "success")
        warnings.push(
          `After-tool hook ${report.name}: ${report.status}. Tool outcome is unchanged. ${report.output}`,
        );
    return this.withWarnings(result, warnings);
  }

  private async finalizeCheckpoint(
    checkpoint: string | undefined,
    result: ToolResult,
  ): Promise<string[]> {
    try {
      await this.checkpoints.after(checkpoint, result);
      return [];
    } catch {
      return [
        "Checkpoint finalization failed; inspect the file before retrying. Do not replay the edit.",
      ];
    }
  }

  private withWarnings(result: ToolResult, warnings: string[], uncertain = false): ToolResult {
    const suffix = warnings.length ? `\n${warnings.join("\n")}` : "";
    return {
      ...result,
      text: result.text + suffix,
      fullOutput: (result.fullOutput ?? result.text) + suffix,
      ...(uncertain ? { outcomeUncertain: true } : {}),
    };
  }
}
