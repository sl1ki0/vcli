import {
  WorkspaceSettingsError,
  type WorkspaceSettings,
  type WorkspaceSettingsUpdate,
} from "@vcli/tui";
import { patchConfig, validateConfig, type Config, type ConfigPatch } from "./config.ts";
import {
  credentialScope,
  normalizeEndpoint,
  resolveCredential,
  saveCredential,
  validateApiKey,
} from "./credentials.ts";
import type { HarnessOptions } from "./harness.ts";
import { OPENROUTER_BASE_URL, REASONING_EFFORTS, validateProviderReasoning } from "@vcli/providers";

interface SessionCredential {
  apiKey: string;
  saved: boolean;
}
export interface WorkspaceSettingsController {
  currentConfig(): Config;
  snapshot(): Promise<WorkspaceSettings>;
  configure(update: WorkspaceSettingsUpdate): Promise<WorkspaceSettings>;
  /** Runtime only; never serialize these options into configuration or session records. */
  harnessOptions(): HarnessOptions;
}

function validateBudgets(config: Config): void {
  if ((config.contextWindow ?? 32_768) - config.context.outputTokens < 1024)
    throw new WorkspaceSettingsError(
      "budgets",
      "Reduce output tokens or increase the context window; reserve at least 1024 tokens for the prompt",
    );
}

function settingsPatch(update: WorkspaceSettingsUpdate): ConfigPatch {
  switch (update.kind) {
    case "connection": {
      if (typeof update.model !== "string" || !update.model.trim() || /[\r\n\0]/.test(update.model))
        throw new WorkspaceSettingsError("model", "Enter a single-line model name");
      if (typeof update.saveKey !== "boolean") throw new Error("Choose whether to save the key");
      let baseURL: string | undefined;
      try {
        baseURL = normalizeEndpoint(update.baseURL?.trim());
      } catch {
        throw new WorkspaceSettingsError(
          "endpoint",
          "Use an HTTP(S) endpoint without credentials, query, or fragment",
        );
      }
      if (update.provider === "compatible" && !baseURL)
        throw new WorkspaceSettingsError("endpoint", "A compatible provider needs an endpoint URL");
      return { provider: update.provider, model: update.model.trim(), baseURL: baseURL ?? null };
    }
    case "budgets":
      if (!update.context || typeof update.context !== "object" || Array.isArray(update.context))
        throw new Error("Context budgets must be an object");
      return {
        contextWindow: update.contextWindow,
        context: { ...update.context, taskTokens: update.context.taskTokens ?? null },
      };
    case "permission":
      return { permission: update.permission };
    case "reasoning":
      if (!REASONING_EFFORTS.includes(update.reasoning))
        throw new WorkspaceSettingsError("reasoning", "Choose a supported reasoning effort");
      return { reasoning: update.reasoning };
    default:
      throw new Error("Unknown settings update");
  }
}

export function createWorkspaceSettings(
  root: string,
  initialConfig: Config,
  initialHarnessOptions: HarnessOptions = {},
): WorkspaceSettingsController {
  let current = structuredClone(validateConfig(initialConfig));
  const sessionKeys = new Map<string, SessionCredential>();
  if (initialHarnessOptions.apiKey)
    sessionKeys.set(credentialScope(current), {
      apiKey: validateApiKey(initialHarnessOptions.apiKey),
      saved: false,
    });
  let pending: Promise<unknown> = Promise.resolve();

  const snapshot = async (): Promise<WorkspaceSettings> => {
    const override = sessionKeys.get(credentialScope(current));
    const resolved = await resolveCredential(current, override?.apiKey);
    return {
      provider: current.provider,
      model: current.model,
      baseURL:
        current.baseURL ?? (current.provider === "openrouter" ? OPENROUTER_BASE_URL : undefined),
      reasoning: current.reasoning ?? "default",
      credential: override?.saved ? "saved" : resolved.status,
      permission: current.permission,
      contextWindow: current.contextWindow ?? 32_768,
      context: structuredClone(current.context),
    };
  };

  const configure = async (update: WorkspaceSettingsUpdate): Promise<WorkspaceSettings> => {
    const patch = settingsPatch(update);
    const context = { ...current.context, ...patch.context };
    const next = validateConfig({
      ...current,
      ...patch,
      baseURL: patch.baseURL === null ? undefined : (patch.baseURL ?? current.baseURL),
      context: {
        ...context,
        taskTokens: context.taskTokens === null ? undefined : context.taskTokens,
      },
    });
    validateBudgets(next);
    if (update.kind === "connection" || update.kind === "reasoning") {
      try {
        validateProviderReasoning(next);
      } catch (error) {
        throw new WorkspaceSettingsError(
          "reasoning",
          error instanceof Error ? error.message : "Choose a supported reasoning effort",
        );
      }
    }
    const enteredKey =
      update.kind === "connection" && update.apiKey?.trim()
        ? validateApiKey(update.apiKey)
        : undefined;
    const retained = sessionKeys.get(credentialScope(next));
    const savedKey =
      update.kind === "connection" && update.saveKey
        ? (await resolveCredential(next, enteredKey ?? retained?.apiKey)).apiKey
        : undefined;
    // Validate the whole update before writing either settings or credentials.
    if (savedKey) await saveCredential(next, savedKey);
    await patchConfig(root, patch, true);
    if (update.kind === "connection" && (enteredKey || savedKey)) {
      sessionKeys.set(credentialScope(next), {
        apiKey: (enteredKey ?? savedKey)!,
        saved: update.saveKey,
      });
    }
    current = structuredClone(next);
    return snapshot();
  };

  return {
    currentConfig: () => structuredClone(current),
    snapshot: async () => {
      await pending;
      return snapshot();
    },
    configure: (update) => {
      const operation = pending.then(() => configure(update));
      pending = operation.catch(() => undefined);
      return operation;
    },
    harnessOptions: () => {
      const key = sessionKeys.get(credentialScope(current));
      return key ? { apiKey: key.apiKey } : {};
    },
  };
}
