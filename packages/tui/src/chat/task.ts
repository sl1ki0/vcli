import { createSignal, onCleanup } from "solid-js";
import type { ApprovalDecision, RuntimeEvent, ToolDefinition } from "@vcli/core";
import type { WorkspaceOptions } from "../contracts.ts";
import type { Conversation } from "./conversation.ts";
import { presentToolRequest, type ToolRequest } from "./tool-request.ts";
import { approvalActions } from "./approval-actions.ts";

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
  const [approval, setApproval] = createSignal<{
    request: ToolRequest;
    selected: number;
    actions: typeof approvalActions;
    finish(allow: ApprovalDecision): void;
  }>();
  let controller: AbortController | undefined;
  let completion = Promise.resolve();
  const requestApproval = (
    tool: ToolDefinition,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    remember = true,
  ) =>
    new Promise<ApprovalDecision>((resolve) => {
      if (signal?.aborted || controller?.signal.aborted) return resolve(false);
      const actions = remember
        ? approvalActions
        : approvalActions.filter((action) => action.decision !== "always");
      const finish = (decision: ApprovalDecision) => {
        signal?.removeEventListener("abort", cancelRequest);
        if (approval()?.finish === finish) setApproval(undefined);
        resolve(decision);
      };
      const cancelRequest = () => finish(false);
      signal?.addEventListener("abort", cancelRequest, { once: true });
      setApproval({
        request: presentToolRequest(tool, args),
        actions,
        selected: actions.length - 1,
        finish,
      });
    });
  const requestOneTimeApproval = (tool: ToolDefinition, args: Record<string, unknown>) =>
    requestApproval(tool, args, undefined, false).then((decision) => decision === true);
  async function start(prompt: string) {
    if (running() || !options.workspace.run) return;
    controller = new AbortController();
    const current = controller;
    let settled!: () => void;
    completion = new Promise<void>((resolve) => {
      settled = resolve;
    });
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
      if (status === "aborted") options.activity("Task canceled. You can send a new message.");
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
      try {
        await options.refresh();
      } finally {
        settled();
      }
    }
  }
  async function cancelAndWait() {
    const pending = completion;
    cancel();
    await pending;
  }
  function cancel() {
    if (!controller || controller.signal.aborted) return;
    approval()?.finish(false);
    setApproval(undefined);
    controller?.abort();
    options.activity("Canceling task…");
  }
  function approve(allow: ApprovalDecision) {
    approval()?.finish(allow);
  }
  function moveApproval(direction: number, wrap = false) {
    setApproval((pending) => {
      if (!pending) return;
      const selected = pending.selected + direction;
      return {
        ...pending,
        selected: wrap
          ? (selected + pending.actions.length) % pending.actions.length
          : Math.max(0, Math.min(pending.actions.length - 1, selected)),
      };
    });
  }
  function confirmApproval() {
    const pending = approval();
    if (pending) approve(pending.actions[pending.selected]!.decision);
  }
  onCleanup(() => {
    approval()?.finish(false);
    controller?.abort();
  });
  return {
    running,
    approval,
    start,
    cancel,
    cancelAndWait,
    approve,
    moveApproval,
    confirmApproval,
    requestApproval,
    requestOneTimeApproval,
  };
}
