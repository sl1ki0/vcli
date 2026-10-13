import { createSignal, onCleanup } from "solid-js";
import type { RuntimeEvent, ToolDefinition } from "@vcli/core";
import type { WorkspaceOptions } from "../contracts.ts";
import type { Conversation } from "./conversation.ts";

interface TaskOptions {
  workspace: WorkspaceOptions;
  conversation: Conversation;
  emit(event: RuntimeEvent): Promise<void>;
  activity(text: string): void;
  present(): Promise<void>;
  refresh(): Promise<void>;
}
export function createChatTask(options: TaskOptions) {
  const [running, setRunning] = createSignal(false);
  const [approval, setApproval] = createSignal<{ label: string; finish(allow: boolean): void }>();
  let controller: AbortController | undefined;
  const requestApproval = (tool: ToolDefinition, args: Record<string, unknown>) =>
    new Promise<boolean>((finish) => {
      setApproval({ label: `${tool.name}: ${JSON.stringify(args).slice(0, 700)}`, finish });
    });
  async function start(prompt: string) {
    if (running() || !options.workspace.run) return;
    controller = new AbortController();
    const current = controller;
    setRunning(true);
    options.conversation.send(prompt);
    options.activity("Message sent. Waiting for model…");
    try {
      await options.present();
      const session = await options.workspace.run(
        prompt,
        current.signal,
        async (event) => {
          options.conversation.accept(event);
          await options.emit(event);
        },
        requestApproval,
      );
      const status =
        session.status === "aborted"
          ? "aborted"
          : session.status === "failed" || session.status === "budget"
            ? "failed"
            : "complete";
      options.conversation.finish(session, status);
    } catch (error) {
      options.conversation.finish(undefined, current.signal.aborted ? "aborted" : "failed");
      options.activity(
        current.signal.aborted
          ? "Task canceled."
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      setRunning(false);
      setApproval(undefined);
      controller = undefined;
      await options.refresh();
    }
  }
  function cancel() {
    approval()?.finish(false);
    setApproval(undefined);
    controller?.abort();
    options.activity("Canceling task…");
  }
  function approve(allow: boolean) {
    approval()?.finish(allow);
    setApproval(undefined);
  }
  onCleanup(() => {
    approval()?.finish(false);
    controller?.abort();
  });
  return { running, approval, start, cancel, approve, requestApproval };
}
