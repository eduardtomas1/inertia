import { agentRunStateForTurn } from "@shared/run-state";
import type { AgentActivity } from "@shared/contracts";
import { activityExecutionCategory, type ActivityExecutionCategory } from "@shared/activity-display";

import type { ResponseTurn } from "./model";

export type StreamingAgentChannel = "text" | "reasoning" | null;

export { activityExecutionCategory, type ActivityExecutionCategory };

export type ActiveAgentPhase =
  | "compacting"
  | "queued"
  | "starting"
  | "thinking"
  | "searching"
  | "coding"
  | "command"
  | "tool"
  | "responding"
  | "working"
  | "delegated"
  | "retrying"
  | "cancelling"
  | "waiting-for-approval"
  | "waiting-for-input";

export interface ActiveAgentPresentation {
  phase: ActiveAgentPhase;
  label: string;
  detail?: string | null;
  animated: boolean;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestRunningActivity(
  activities: readonly AgentActivity[],
): AgentActivity | null {
  let latest: AgentActivity | null = null;
  for (const activity of activities) {
    if (
      activity.status !== "running"
      || (activity.kind !== "tool"
        && activity.kind !== "command"
        && activity.kind !== "file"
        && activity.kind !== "reasoning")
    ) continue;
    if (
      latest === null
      || timestamp(activity.createdAt) >= timestamp(latest.createdAt)
    ) {
      latest = activity;
    }
  }
  return latest;
}

/**
 * Derives the active presentation from authoritative turn lifecycle, running
 * provider actions, and the currently open live stream segment. Persisted
 * reasoning is history, not proof that the provider is still thinking.
 */
export function activeAgentPresentation(input: {
  turn: {
    agentTurn: Pick<ResponseTurn["agentTurn"], "status" | "runState">;
    activities: readonly AgentActivity[];
  };
  providerLabel: string;
  streamingChannel: StreamingAgentChannel;
}): ActiveAgentPresentation {
  const status = agentRunStateForTurn(input.turn.agentTurn);
  const lifecycle = status === "running"
    ? null
    : status[0] === "w"
      ? status.endsWith("input") ? "is waiting for input" : "needs approval"
      : status === "queued" || status === "starting"
        ? `is ${status}`
        : status === "delegated"
          ? "delegating"
          : status === "cancelling" ? "stopping" : status;
  if (lifecycle) {
    return {
      phase: status as ActiveAgentPhase,
      label: `${input.providerLabel} ${lifecycle}`,
      animated: status[0] !== "w",
    };
  }

  // These are canonical adapter labels, not matches against arbitrary tool
  // output or context occupancy. A completed event is history, not live work.
  if (input.turn.activities.some((activity) => activity.kind === "status"
    && activity.status === "running"
    && /^(?:Context compaction|Claude is compacting context|(?:Cursor|Kimi Code) is compacting session context)$/u.test(activity.title))) {
    return { phase: "compacting", label: "Compacting context…", animated: true };
  }

  const activity = latestRunningActivity(input.turn.activities);
  if (activity) {
    const category = activityExecutionCategory(activity);
    switch (category) {
      case "reasoning":
        return {
          phase: "thinking",
          label: `${input.providerLabel} is thinking`,
          detail: null,
          animated: true,
        };
      case "searching":
        return {
          phase: "searching",
          label: `${input.providerLabel} is searching`,
          detail: activity.title,
          animated: true,
        };
      case "coding":
        return {
          phase: "coding",
          label: `${input.providerLabel} is coding`,
          detail: activity.title,
          animated: true,
        };
      case "command":
        return {
          phase: "command",
          label: `${input.providerLabel} is running a command`,
          detail: activity.title === "Command" ? null : activity.title,
          animated: true,
        };
      case "tool":
        return {
          phase: "tool",
          label: `${input.providerLabel} is using a tool`,
          detail: activity.title === "Tool" ? null : activity.title,
          animated: true,
        };
      case "attention":
        break;
    }
  }

  if (input.streamingChannel === "reasoning") {
    return {
      phase: "thinking",
      label: `${input.providerLabel} is thinking`,
      detail: null,
      animated: true,
    };
  }
  if (input.streamingChannel === "text") {
    return {
      phase: "responding",
      label: `${input.providerLabel} is responding`,
      detail: null,
      animated: true,
    };
  }
  return {
    phase: "working",
    label: `${input.providerLabel} is working`,
    detail: null,
    animated: true,
  };
}

export function activeAgentPhase(input: {
  turn: {
    agentTurn: Pick<ResponseTurn["agentTurn"], "status" | "runState">;
    activities: readonly AgentActivity[];
  };
  streamingChannel: StreamingAgentChannel;
}): ActiveAgentPhase {
  return activeAgentPresentation({ ...input, providerLabel: "" }).phase;
}
