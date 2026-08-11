import type { AgentTurn } from "@shared/contracts";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";

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

export function goalControlsBusy(input: {
  connectionStatus: ConnectionStatus;
  workflowLoading: boolean;
  safetyLocked: boolean;
  executionStatus: GoalExecutionStatus;
  busyAction: string | null;
}): boolean {
  return input.connectionStatus !== "online"
    || input.workflowLoading
    || input.safetyLocked
    || input.executionStatus === "starting"
    || input.busyAction === "agent.stop"
    || input.busyAction?.startsWith("agent.goal") === true;
}
