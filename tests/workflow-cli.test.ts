import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { workflowsSmoke } from "../scripts/smoke-workflows.ts";

test("public CLI plans, resumes in plan mode, implements explicitly and rewinds a captured edit", async () => {
  expect(
    await workflowsSmoke([process.execPath, resolve(import.meta.dir, "../apps/cli/src/index.ts")]),
  ).toEqual({
    requests: 7,
    planProtected: true,
    resumedPlan: true,
    tasksPersisted: true,
    rewind: true,
  });
}, 20_000);
