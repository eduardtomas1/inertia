import type { AgentActivity, AgentTurnStatus } from "@shared/contracts";

import type { ResponseTurn } from "./model";

export type StreamingAgentChannel = "text" | "reasoning" | null;

export type ActivityExecutionCategory =
  | "searching"
  | "coding"
  | "command"
  | "reasoning"
  | "tool"
  | "attention";

export type ActiveAgentPhase =
  | "queued"
  | "starting"
  | "thinking"
  | "searching"
  | "coding"
  | "command"
  | "tool"
  | "responding"
  | "working"
  | "waiting-for-approval"
  | "waiting-for-input";

export interface ActiveAgentPresentation {
  phase: ActiveAgentPhase;
  label: string;
  detail: string | null;
  animated: boolean;
}

const SEARCH_ACTIVITY_PATTERN = /\b(?:browse|browser|fetch|find online|lookup|query|search|web)\b/iu;
const CODING_ACTIVITY_PATTERN = /\b(?:apply patch|code|create file|edit|file change|patch|refactor|rewrite|write)\b/iu;

function normalizedActivityTitle(title: string): string {
  return title
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ");
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Classifies only explicit provider/runtime activity. Ambiguous tool names stay
 * generic instead of becoming invented product stages.
 */
export function activityExecutionCategory(
  activity: Pick<AgentActivity, "kind" | "title" | "status">,
): ActivityExecutionCategory {
  if (activity.status === "failed" || activity.kind === "error") {
    return "attention";
  }
  if (activity.kind === "reasoning") return "reasoning";
  if (activity.kind === "command") return "command";
  if (activity.kind === "file") return "coding";
  const normalizedTitle = normalizedActivityTitle(activity.title);
  if (SEARCH_ACTIVITY_PATTERN.test(normalizedTitle)) return "searching";
  if (CODING_ACTIVITY_PATTERN.test(normalizedTitle)) {
    return "coding";
  }
  return "tool";
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

function lifecyclePresentation(
  status: Extract<
    AgentTurnStatus,
    "queued" | "starting" | "waiting-for-approval" | "waiting-for-input"
  >,
  providerLabel: string,
): ActiveAgentPresentation {
  switch (status) {
    case "queued":
      return {
        phase: "queued",
        label: `${providerLabel} is queued`,
        detail: null,
        animated: true,
      };
    case "starting":
      return {
        phase: "starting",
        label: `${providerLabel} is starting`,
        detail: null,
        animated: true,
      };
    case "waiting-for-approval":
      return {
        phase: "waiting-for-approval",
        label: `${providerLabel} needs approval`,
        detail: null,
        animated: false,
      };
    case "waiting-for-input":
      return {
        phase: "waiting-for-input",
        label: `${providerLabel} is waiting for input`,
        detail: null,
        animated: false,
      };
  }
}

/**
 * Derives the active presentation from authoritative turn lifecycle, running
 * provider actions, and the currently open live stream segment. Persisted
 * reasoning is history, not proof that the provider is still thinking.
 */
export function activeAgentPresentation(input: {
  turn: Pick<ResponseTurn, "agentTurn" | "activities">;
  providerLabel: string;
  streamingChannel: StreamingAgentChannel;
}): ActiveAgentPresentation {
  const { status } = input.turn.agentTurn;
  if (
    status === "queued"
    || status === "starting"
    || status === "waiting-for-approval"
    || status === "waiting-for-input"
  ) {
    return lifecyclePresentation(status, input.providerLabel);
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
