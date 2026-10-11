import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { onboardingSmoke } from "../scripts/smoke-onboarding.ts";

test("first-run source CLI opens a project, connects a model without echoing its key, and saves token settings", async () => {
  const result = await onboardingSmoke([
    process.execPath,
    resolve(import.meta.dir, "../apps/cli/src/index.ts"),
  ]);
  expect(result).toEqual({ modelRequests: 1, promptTokens: 12_288, terminalRestored: true });
}, 35_000);
