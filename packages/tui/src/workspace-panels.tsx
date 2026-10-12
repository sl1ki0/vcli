import { For, Show, createEffect, createMemo } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { WorkspaceCommands } from "./workspace-commands.ts";

function SettingsSummary(props: { commands: WorkspaceCommands }) {
  const settings = props.commands.settings;
  return (
    <text fg="#b8c4d2">
      {settings()
        ? `${settings()!.provider} · ${settings()!.model || "model not set"}\nCredential: ${settings()!.credential} · Permission: ${settings()!.permission.toUpperCase()} · Reasoning: ${settings()!.reasoning ?? "default"}\nContext window: ${settings()!.contextWindow.toLocaleString("en-US")} · Prompt: ${settings()!.context.promptTokens.toLocaleString("en-US")} · Output: ${settings()!.context.outputTokens.toLocaleString("en-US")}${settings()!.baseURL ? "\nEndpoint: " + settings()!.baseURL : ""}`
        : "No provider connection configured."}
    </text>
  );
}

export function EmptyProject(props: { root: string; commands: WorkspaceCommands }) {
  return (
    <box flexDirection="column" padding={2}>
      <text fg="#6ee7c2">No source files in this folder</text>
      <text fg="#b8c4d2">{`${props.root}\nOpen a project folder to see its modules and dependencies.\nYou can also create source files here and use /scan.`}</text>
      <text fg="#38bdf8" onMouseDown={() => props.commands.open("open")}>
        Open project · /open
      </text>
      <text fg="#38bdf8" onMouseDown={() => props.commands.open("help")}>
        Help / commands · F1
      </text>
    </box>
  );
}

export function WorkspacePanels(props: {
  commands: WorkspaceCommands;
  root: string;
  running: boolean;
}) {
  const commands = props.commands;
  let menuScroll: ScrollBoxRenderable | undefined;
  createEffect(() => {
    commands.panel();
    commands.history.sessions();
    const selected = commands.choice();
    menuScroll?.scrollChildIntoView(`setup-choice-${selected}`);
  });
  const title = createMemo(() => {
    switch (commands.panel()) {
      case "welcome":
        return "Welcome to vcli";
      case "help":
        return "Help / commands";
      case "config":
        return "Project settings";
      case "tokens":
        return "Token budgets";
      case "permission":
        return "Permission mode";
      case "reasoning":
        return "Reasoning effort";
      case "history":
        return "Conversation history";
      case "open":
        return "Open project";
      case "status":
        return "Workspace status";
      case "read":
        return commands.readTitle();
      case "connect":
        return commands.connection.step() === "storage" ? "Key storage" : "Connect provider";
    }
  });
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      backgroundColor="#17212d"
    >
      <text height={1} fg="#6ee7c2">
        {title()}
      </text>
      <scrollbox
        flexGrow={1}
        width="100%"
        ref={(scroll: ScrollBoxRenderable) => {
          menuScroll = scroll;
        }}
      >
        <Show when={commands.panel() === "welcome"}>
          <text fg="#b8c4d2">
            {commands.emptyProject()
              ? `No source files were found in this folder.\n${props.root}\nChoose Open project to see your architecture take shape.`
              : "Explore your project architecture, then connect a provider to start coding."}
          </text>
          <text fg="#8e9ba9">Setup, settings, help and graph navigation use no model tokens.</text>
          <SettingsSummary commands={commands} />
        </Show>
        <Show when={commands.panel() === "help"}>
          <text fg="#b8c4d2">Choose a command, or press Esc and type it in the task input.</text>
          <text fg="#8e9ba9">
            F2 full chat · F3 full architecture · Tab focus · chat ↑/↓ messages · PgUp/PgDn scroll ·
            Home/End first/latest · Space/Enter reasoning · input ↑ recalls prompts · graph arrows
            select · Shift+arrows pan · +/- zoom · Ctrl+C stop
          </text>
        </Show>
        <Show when={commands.panel() === "config" || commands.panel() === "status"}>
          <SettingsSummary commands={commands} />
          <text fg="#b8c4d2">{`Project: ${props.root}\nTask: ${props.running ? "running" : "idle"}`}</text>
          <text fg="#8e9ba9">
            Connection and budget settings apply to this project. Use /connect or /tokens to edit.
          </text>
        </Show>
        <Show when={commands.panel() === "connect"}>
          <text fg="#b8c4d2">{`Provider: ${commands.connection.provider()}${commands.connection.model() ? " · " + commands.connection.model() : ""}`}</text>
          <Show when={commands.connection.step() === "provider"}>
            <text fg="#8e9ba9">
              Choose a provider. Setup stores connection details without making a model request.
            </text>
          </Show>
          <Show when={commands.connection.step() === "key"}>
            <text fg="#6ee7c2">API key</text>
            <text fg="#b8c4d2">
              Type or paste your key. Enter continues; Backspace edits; Ctrl+U clears.
            </text>
            <text fg="#8e9ba9">
              Leave blank to keep an existing credential. Compatible endpoints may use no key.
            </text>
            <text id="masked-api-key" fg="#fbbf24">
              {commands.connection.mask() || "[waiting for key]"}
            </text>
          </Show>
          <Show when={commands.connection.step() === "storage"}>
            <text fg="#b8c4d2">
              Session only is the default. Saving writes an unencrypted local key file readable only
              by this user.
            </text>
          </Show>
        </Show>
        <Show when={commands.panel() === "tokens"}>
          <text fg="#b8c4d2">
            Edit a field, then choose Save token budgets. Esc discards staged changes.
          </text>
          <text fg="#8e9ba9">
            Input budgets use local token estimates. Actual provider usage is tracked separately.
          </text>
        </Show>
        <Show when={commands.panel() === "reasoning"}>
          <text fg="#b8c4d2">{`Current effort: ${commands.settings()?.reasoning ?? "default"}. Choose an effort for future requests.`}</text>
          <text fg="#8e9ba9">
            Available efforts depend on the model. Unsupported settings produce a clear error.
            Higher effort may use more tokens. The chat only shows reasoning returned by your
            provider.
          </text>
        </Show>
        <Show when={commands.panel() === "history"}>
          <text fg="#b8c4d2">
            Choose a saved conversation to restore its messages and continue. History is stored
            locally and opening it makes no model request.
          </text>
          <Show when={commands.history.loading()}>
            <text fg="#8e9ba9">Loading saved conversations…</text>
          </Show>
          <Show when={!commands.history.loading() && !commands.history.sessions().length}>
            <text fg="#8e9ba9">
              No saved conversations yet. Send your first message to create one.
            </text>
          </Show>
          <Show when={commands.history.error()}>
            <text fg="#fbbf24">{commands.history.error()}</text>
          </Show>
        </Show>
        <Show when={commands.panel() === "open"}>
          <text fg="#b8c4d2">
            Open a folder containing your source. Its architecture will be scanned before switching.
          </text>
        </Show>
        <Show when={commands.panel() === "read"}>
          <text fg="#b8c4d2">{commands.readContent()}</text>
        </Show>
        <For each={commands.choices()}>
          {(item, index) => (
            <text
              id={`setup-choice-${index()}`}
              fg={index() === commands.choice() ? "#6ee7c2" : "#b8c4d2"}
              onMouseDown={() => {
                if (!commands.working()) void item.select();
              }}
            >{`${index() === commands.choice() ? "›" : " "} ${index() + 1}. ${item.label}${item.detail ? " · " + item.detail : ""}`}</text>
          )}
        </For>
        <Show when={commands.message()}>
          <text fg="#fbbf24">{commands.message()}</text>
        </Show>
        <Show when={commands.working()}>
          <text fg="#8e9ba9">Applying local settings…</text>
        </Show>
      </scrollbox>
      <Show when={commands.input()} keyed>
        {(field) => (
          <box flexDirection="column" height={field.hint ? 4 : 2}>
            <text fg="#6ee7c2">{field.label}</text>
            <Show when={field.hint}>
              <text fg="#8e9ba9">{field.hint}</text>
            </Show>
            <input
              id="setup-field"
              value={field.value}
              focused={!commands.working()}
              placeholder={field.placeholder}
              onSubmit={(value) => {
                if (typeof value === "string") void commands.submitInput(value);
              }}
            />
          </box>
        )}
      </Show>
      <text height={1} fg="#64748b">
        ↑/↓ choose · Enter select · 1–9 shortcuts · Esc cancel · F1 help
      </text>
    </box>
  );
}
