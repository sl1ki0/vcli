import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalOrder = `def calculate_total(prices: list[float], discount_percent: float) -> float:
    return sum(prices) - discount_percent
`;
const originalTests = `import unittest

from order import calculate_total


class OrderTest(unittest.TestCase):
    def test_discount(self) -> None:
        self.assertEqual(calculate_total([100, 50], 10), 135)

    def test_invalid_discount(self) -> None:
        for value in (-1, 101):
            with self.assertRaises(ValueError):
                calculate_total([100], value)
`;

/** The compiled executable operates entirely in a fresh project outside the checkout. */
export async function homeworkSmoke(binary: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "vcli-homework-smoke-")));
  const workspace = join(directory, "workspace");
  const policy = join(directory, "policy.json");
  const state = join(directory, "runs.sqlite");
  const run = async (...args: string[]) => {
    const child = Bun.spawn([binary, "homework", ...args, "--state", state], {
      cwd: workspace,
      env: {
        ...Bun.env,
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
        OPENAI_MODEL: "",
        VCLI_CONFIG_HOME: join(directory, "configuration"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code || stderr || stdout.includes("\u001b"))
      throw new Error(`Packaged homework command failed: ${args.join(" ")} (${code})\n${stderr}`);
    return stdout;
  };
  const readState = (id: string) => {
    const db = new Database(state, { readonly: true });
    try {
      const row = db.query("SELECT snapshot FROM homework_runs WHERE id = ?").get(id) as {
        snapshot: string;
      } | null;
      if (!row) throw new Error("Packaged homework run was not persisted");
      return JSON.parse(row.snapshot) as {
        spent: Record<string, number>;
        calls: {
          call: { name: string };
          attempts: number;
          result?: { text: string; exitCode?: number; isError?: boolean };
        }[];
      };
    } finally {
      db.close();
    }
  };
  try {
    await mkdir(join(workspace, "private"), { recursive: true });
    await writeFile(join(workspace, "order.py"), originalOrder);
    await writeFile(join(workspace, "test_order.py"), originalTests);
    await writeFile(join(workspace, "private/example.txt"), "Policy-denied educational fixture.\n");
    await writeFile(
      policy,
      JSON.stringify({
        version: 1,
        commands: { allow: ["python3 -m unittest -v"], deny: ["rm -rf workspace"] },
        directories: { allow: ["."], deny: ["private"] },
        timeoutMs: 10000,
        maxOutputBytes: 65536,
      }),
    );
    const planning = await run(
      "start",
      "--workspace",
      workspace,
      "--policy",
      policy,
      "--mode",
      "auto",
      "--plan",
      "--demo",
      "Fix the order calculation so the original tests pass. Do not change tests. Find files, fix code, run tests.",
    );
    const id = planning.match(/^run_id: ([a-f0-9-]+)$/m)?.[1];
    if (!id || !planning.includes("status: waiting-plan"))
      throw new Error("Packaged homework did not pause for structured plan approval");
    if ((await readFile(join(workspace, "order.py"), "utf8")) !== originalOrder)
      throw new Error("Packaged homework changed source before plan approval");
    const finished = await run("plan", id, "approve", "--demo");
    if (!finished.includes("status: complete"))
      throw new Error("Packaged homework did not finish after plan approval");
    const complete = readState(id);
    const bash = complete.calls.filter((entry) => entry.call.name === "Bash");
    if (
      bash.length !== 1 ||
      bash[0]?.result?.exitCode !== 0 ||
      bash[0]?.result?.isError ||
      !bash[0]?.result?.text.includes("Ran 2 tests")
    )
      throw new Error("Packaged homework did not verify the original tests through actual Bash");
    if ((await readFile(join(workspace, "test_order.py"), "utf8")) !== originalTests)
      throw new Error("Packaged homework changed the original tests");
    const tasks = await run("tasks", id);
    if (tasks.match(/^\[x\]/gm)?.length !== 3 || !tasks.includes("evidence"))
      throw new Error("Packaged homework did not retain three verified tasks");
    const diff = await run("diff", id);
    if (!diff.includes("--- a/order.py") || diff.includes("a/test_order.py"))
      throw new Error("Packaged homework diff missed source changes or included test edits");
    await run("resume", id, "--demo");
    const resumed = readState(id);
    if (
      JSON.stringify(resumed.spent) !== JSON.stringify(complete.spent) ||
      JSON.stringify(resumed.calls) !== JSON.stringify(complete.calls)
    )
      throw new Error("Packaged homework replayed completed actions on resume");
    if (!(await run("rollback", id)).includes("status: rolled-back"))
      throw new Error("Packaged homework did not record rollback");
    if (
      (await readFile(join(workspace, "order.py"), "utf8")) !== originalOrder ||
      (await readFile(join(workspace, "test_order.py"), "utf8")) !== originalTests
    )
      throw new Error("Packaged homework did not restore source and preserve tests");
    return {
      planProtected: true,
      bashVerified: true,
      tasksPersisted: true,
      resumed: true,
      rollback: true,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
