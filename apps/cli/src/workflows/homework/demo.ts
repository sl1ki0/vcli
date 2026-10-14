import type { ModelRequest, ProviderAdapter, RunTask, ToolCall } from "@vcli/core";

export const orderFix = `def calculate_total(prices: list[float], discount_percent: float) -> float:
    if not 0 <= discount_percent <= 100:
        raise ValueError("discount_percent must be between 0 and 100")
    return sum(prices) * (1 - discount_percent / 100)
`;

/** Offline scripted model boundary; filesystem, Bash, approvals and persistence stay real. */
export function homeworkDemo(): ProviderAdapter {
  return {
    id: "homework-demo",
    model: "deterministic-order-fixture",
    contextWindow: 32768,
    async *stream(request: ModelRequest) {
      const all = request.messages.flatMap((message) => message.toolCalls ?? []);
      const id = (suffix: string) => `demo-${all.length}-${suffix}`;
      const call = (name: string, args: Record<string, unknown>, suffix = name): ToolCall => ({
        id: id(suffix),
        name,
        arguments: args,
      });
      const current = request.system.match(/Current task: (.+)\. Use complete_task/);
      const task = current ? (JSON.parse(current[1]!) as RunTask) : undefined;
      const lastTool = request.messages.filter((message) => message.role === "tool").at(-1);
      if (lastTool?.text.includes("Human declined") || lastTool?.text.includes("unsuccessful")) {
        yield {
          type: "text",
          text: "The action was declined or its uncertain outcome was failed. Inspect the run before issuing a new task.",
        };
        return;
      }
      let calls: ToolCall[];
      if (request.system.includes("Planning: only read")) {
        if (!all.some((entry) => entry.name === "read_file")) {
          calls = [call("list_files", { path: "." }), call("read_file", { path: "order.py" })];
        } else {
          calls = [
            call("submit_plan", {
              goal: "Fix order discount calculation without changing test_order.py",
              steps: [
                {
                  id: "inspect",
                  description: "Read the implementation and unchanged tests",
                  dependsOn: [],
                  tools: ["list_files", "read_file"],
                  outcome: { tool: "read_file", contains: "test_discount" },
                },
                {
                  id: "fix",
                  description: "Validate discount and apply percentage to the sum",
                  dependsOn: ["inspect"],
                  tools: ["write_file", "read_file"],
                  outcome: { tool: "write_file", contains: "order.py" },
                },
                {
                  id: "verify",
                  description: "Run the original Python unittest suite through Bash",
                  dependsOn: ["fix"],
                  tools: ["Bash"],
                  outcome: { tool: "Bash", exitCode: 0 },
                },
              ],
              risks: ["Invalid discount must raise ValueError", "Test files must remain unchanged"],
              assumptions: ["Python 3 with unittest is available"],
              doneWhen: "Original tests pass through Bash and test_order.py has its original bytes",
            }),
          ];
        }
      } else if (task) {
        const lastBoundary = [...all]
          .reverse()
          .findIndex((entry) => ["submit_plan", "complete_task"].includes(entry.name));
        const boundary = lastBoundary < 0 ? -1 : all.length - lastBoundary - 1;
        const taskCalls = all.slice(boundary + 1);
        const evidence = [...taskCalls]
          .reverse()
          .find(
            (entry) =>
              entry.name === task.outcome.tool &&
              (task.id !== "inspect" || entry.arguments.path === "test_order.py"),
          );
        if (evidence) calls = [call("complete_task", { evidence_call_id: evidence.id })];
        else if (task.id === "inspect")
          calls = [
            call("read_file", { path: "order.py" }, "order"),
            call("read_file", { path: "test_order.py" }, "tests"),
          ];
        else if (task.id === "fix")
          calls = [call("write_file", { path: "order.py", content: orderFix })];
        else calls = [call("Bash", { command: "python3 -m unittest -v", cwd: "." })];
      } else if (!all.some((entry) => entry.name === "read_file")) {
        calls = [
          call("list_files", { path: "." }),
          call("read_file", { path: "order.py" }, "order"),
          call("read_file", { path: "test_order.py" }, "tests"),
        ];
      } else if (!all.some((entry) => entry.name === "write_file"))
        calls = [call("write_file", { path: "order.py", content: orderFix })];
      else if (!all.some((entry) => entry.name === "Bash"))
        calls = [call("Bash", { command: "python3 -m unittest -v", cwd: "." })];
      else {
        yield {
          type: "text",
          text: "Order calculation corrected. The original unittest suite passed via Bash; test_order.py was not edited.",
        };
        return;
      }
      for (const entry of calls) yield { type: "tool-call", call: entry };
      yield { type: "done" };
    },
  };
}
