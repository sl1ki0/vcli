import type { Session } from "./contracts.ts";
import { ToolValidationError } from "./tools.ts";

const retryLimit = 3;

export function resetInvalidToolRequests(session: Session, tool: string): boolean {
  const guard = session.invalidToolRequests;
  if (!guard || !guard.failures.some((failure) => failure.tool === tool)) return false;
  guard.failures = guard.failures.filter((failure) => failure.tool !== tool);
  return true;
}

export function recordInvalidToolRequest(
  session: Session,
  tool: string,
  error: ToolValidationError,
): string {
  const guard = (session.invalidToolRequests ??= { failures: [] });
  let attempts = 0;
  for (const signature of error.signatures) {
    let failure = guard.failures.find((item) => item.tool === tool && item.signature === signature);
    if (!failure) {
      failure = { tool, signature, attempts: 0 };
      guard.failures.push(failure);
    }
    failure.attempts++;
    attempts = Math.max(attempts, failure.attempts);
  }
  if (attempts >= retryLimit && !guard.blocked)
    guard.blocked = {
      tool,
      reason: `Stopped after ${retryLimit} requests with the same invalid arguments for ${tool}. ${error.message} Send a new message to retry with corrected arguments or a different approach.`,
    };
  return (
    guard.blocked?.reason ??
    `${error.message} Invalid attempt ${attempts}/${retryLimit} for this schema problem.`
  );
}
