import type { KeyEvent, PasteEvent } from "@opentui/core";
import { createSignal } from "solid-js";
import { WorkspaceSettingsError, type WorkspaceProvider } from "../contracts.ts";
import type { PanelChoice, PanelInput, SetupHost } from "./contracts.ts";
import { createSecretCapture } from "./secret.ts";

type ConnectionStep = "provider" | "model" | "endpoint" | "key" | "storage";
const providers: { id: WorkspaceProvider; label: string }[] = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
  { id: "compatible", label: "OpenAI-compatible endpoint" },
];

export function createConnectionSetup(host: SetupHost) {
  const [step, setStep] = createSignal<ConnectionStep>("provider");
  const [provider, setProvider] = createSignal<WorkspaceProvider>("openai");
  const [model, setModel] = createSignal("");
  const [endpoint, setEndpoint] = createSignal("");
  const secret = createSecretCapture();

  function begin() {
    secret.clear();
    const current = host.settings();
    setProvider(current?.provider ?? "openai");
    setModel(current?.model ?? "");
    setEndpoint(current?.baseURL ?? "");
    setStep("provider");
  }

  function input(): PanelInput | undefined {
    if (step() === "model")
      return {
        label: "Model ID",
        value: model(),
        placeholder: "Enter the provider's model ID",
        hint: "Choose the model available on your account. This does not make a model request.",
      };
    if (step() === "endpoint")
      return {
        label: "Endpoint URL",
        value: endpoint(),
        placeholder: "https://your-provider.example/v1",
        hint:
          provider() === "compatible"
            ? "An HTTP(S) OpenAI-compatible endpoint. Local endpoints may run without a key."
            : "Custom API endpoint. Leave blank to use the provider's default endpoint.",
      };
  }

  function submit(text: string) {
    host.message("");
    if (step() === "model") {
      if (!text.trim() || /[\r\n\0]/.test(text)) {
        host.message("Enter a single-line model ID to continue.");
        return;
      }
      setModel(text.trim());
      setStep(provider() === "compatible" || endpoint() ? "endpoint" : "key");
    } else if (step() === "endpoint") {
      try {
        if (!text.trim() && provider() !== "compatible") {
          setEndpoint("");
          setStep("key");
          return;
        }
        const url = new URL(text.trim());
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error();
        setEndpoint(url.href.replace(/\/+$/, ""));
        setStep("key");
      } catch {
        host.message("Use an HTTP(S) endpoint without credentials, query, or fragment.");
      }
    }
  }

  async function save(saveKey: boolean) {
    const apiKey = secret.take();
    try {
      await host.apply({
        kind: "connection",
        provider: provider(),
        model: model(),
        baseURL: endpoint() || undefined,
        apiKey,
        saveKey,
      });
    } catch (error) {
      // Backend errors can contain request data. Never render them for key setup.
      secret.clear();
      if (error instanceof WorkspaceSettingsError) {
        setStep(error.field === "budgets" ? "model" : error.field);
        host.message(
          error.field === "budgets"
            ? `${error.message}. Press F1 and choose /tokens to adjust budgets.`
            : error.message,
        );
        return;
      }
      setStep("key");
      host.message(
        "Connection could not be saved. Check the provider/model and enter the key again.",
      );
    }
  }

  function choices(): PanelChoice[] {
    if (step() === "provider")
      return providers.map(({ id, label }) => ({
        label,
        select: () => {
          const current = host.settings();
          setProvider(id);
          setModel(current?.provider === id ? current.model : "");
          setEndpoint(current?.provider === id ? (current.baseURL ?? "") : "");
          setStep("model");
        },
      }));
    if (step() === "storage")
      return [
        {
          label: "Session only (default)",
          detail: "Use the key until this process exits.",
          select: () => save(false),
        },
        {
          label: "Save key locally",
          detail: "Unencrypted key file outside the project, accessible only to this user.",
          select: () => save(true),
        },
      ];
    return [];
  }

  function handleKey(key: KeyEvent) {
    if (step() !== "key") return false;
    if (key.name === "return") {
      key.preventDefault();
      key.stopPropagation();
      // Resolve retained/environment credentials for the selected scope in the host.
      host.message("");
      setStep("storage");
    } else secret.handleKey(key);
    return true;
  }

  function handlePaste(event: PasteEvent) {
    if (step() !== "key") return false;
    secret.handlePaste(event);
    return true;
  }

  return {
    begin,
    step,
    provider,
    model,
    endpoint,
    input,
    submit,
    choices,
    handleKey,
    handlePaste,
    mask: secret.mask,
    clear: secret.clear,
  };
}
