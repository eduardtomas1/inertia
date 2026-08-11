import type { AgentTurn } from "@shared/contracts";

export type GoalExecutionStatus = "idle" | "starting" | "running";

const LIVE_TURN_STATUSES = new Set<AgentTurn["status"]>([
  "queued",
  "starting",
  "running",
  "waiting-for-approval",
  "waiting-for-input",
]);

export function goalExecutionStatus(
  turns: readonly AgentTurn[],
): GoalExecutionStatus {
  const live = turns.filter(({ status }) => LIVE_TURN_STATUSES.has(status));
  if (live.length === 0) return "idle";
  return live.some(({ status }) => status === "queued" || status === "starting")
    ? "starting"
    : "running";
}
