import type { AgentGoal, AgentGoalStatus } from "@shared/contracts";
import type { GoalExecutionStatus } from "./goalExecution";

export type GoalActionIcon = "play" | "pause" | "block" | "complete";

export interface GoalAction {
  label: string;
  status: AgentGoalStatus;
  icon: GoalActionIcon;
}

export function goalStatusLabel(status: AgentGoalStatus): string {
  if (status === "usageLimited") return "Usage limited";
  if (status === "budgetLimited") return "Budget limited";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function nextGoalActions(
  goal: AgentGoal,
  executionStatus: GoalExecutionStatus,
): GoalAction[] {
  if (goal.status === "budgetLimited") return [];
  if (
    goal.status === "active"
    && goal.source === "codex-native"
    && executionStatus === "idle"
  ) {
    return [{ label: "Resume goal", status: "active", icon: "play" }];
  }
  if (goal.status === "active") {
    return [
      { label: "Pause", status: "paused", icon: "pause" },
      { label: "Block", status: "blocked", icon: "block" },
      { label: "Complete", status: "complete", icon: "complete" },
    ];
  }
  return [{
    label: goal.status === "complete" ? "Reopen goal" : "Mark active",
    status: "active",
    icon: "play",
  }];
}
