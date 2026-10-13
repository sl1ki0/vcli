import type { ApprovalDecision } from "@vcli/core";

export const approvalActions: { label: string; decision: ApprovalDecision; color: string }[] = [
  { label: "Allow once", decision: true, color: "#6ee7c2" },
  { label: "Always allow this tool for this conversation", decision: "always", color: "#38bdf8" },
  { label: "Deny", decision: false, color: "#fca5a5" },
];
