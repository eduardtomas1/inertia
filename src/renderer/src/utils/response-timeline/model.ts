import { agentRunStateForTurn, isAgentRunTerminalState } from "@shared/run-state";
import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  ChatMessage,
  CheckpointSummary,
  TurnGitArtifact,
} from "@shared/contracts";
import { activityNeedsAttention } from "./activity-attention";

/** Current workspace status is intentionally not accepted by the timeline. */
export type TurnGitArtifactSummary = TurnGitArtifact;

export interface ResponseTurn {
  /** Stable persisted row identity for future virtualization. */
  id: string;
  index: number;
  agentTurn: AgentTurn;
  userMessage: ChatMessage;
  followUpMessages: ChatMessage[];
  assistantMessages: ChatMessage[];
  commentaryMessages: ChatMessage[];
  terminalAssistantMessage: ChatMessage | null;
  systemMessages: ChatMessage[];
  activities: AgentActivity[];
  reasonings: AgentReasoning[];
  reasoning: AgentReasoning | null;
  plans: AgentPlan[];
  approvals: AgentApprovalRequest[];
  inputRequests: AgentInputRequest[];
  checkpoint: CheckpointSummary | null;
  gitArtifact: TurnGitArtifactSummary | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  isActive: boolean;
  toolCallCount: number;
  importantActivities: AgentActivity[];
  foldableActivities: AgentActivity[];
}

/**
 * Clean successful history does not need a second status row above the answer.
 * Its authoritative status and duration live in the answer footer, while the
 * execution transcript remains available from that footer's Run details.
 */
export function shouldConsolidateSettledWorkIntoRunDetails(
  turn: Pick<
    ResponseTurn,
    | "isActive"
    | "agentTurn"
    | "terminalAssistantMessage"
    | "importantActivities"
    | "approvals"
    | "inputRequests"
    | "systemMessages"
  >,
): boolean {
  return !turn.isActive
    && turn.agentTurn.status === "completed"
    && turn.terminalAssistantMessage !== null
    && turn.importantActivities.length === 0
    && turn.approvals.length === 0
    && turn.inputRequests.length === 0
    && turn.systemMessages.length === 0;
}

export interface ResponseTimelineCompatibility {
  inferredTurns: ResponseTurn[];
  malformedTurns: AgentTurn[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  reasonings: AgentReasoning[];
  plans: AgentPlan[];
  checkpoints: CheckpointSummary[];
}

export type ResponseTimelineItem =
  | { kind: "turn"; id: string; turn: ResponseTurn }
  | {
      kind: "compatibility";
      id: "legacy-orphan-history";
      compatibility: ResponseTimelineCompatibility;
    };

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareTimestamped(
  left: { id: string; createdAt: string },
  right: { id: string; createdAt: string },
): number {
  return timestamp(left.createdAt) - timestamp(right.createdAt) || left.id.localeCompare(right.id);
}

function compareTurns(left: AgentTurn, right: AgentTurn): number {
  return timestamp(left.requestedAt) - timestamp(right.requestedAt) || left.id.localeCompare(right.id);
}

function latestReasoning(items: AgentReasoning[]): AgentReasoning | null {
  if (items.length === 0) return null;
  const latest = items.at(-1)!;
  if (items.length === 1) return latest;
  return {
    ...latest,
    content: items.map(({ content }) => content).filter(Boolean).join("\n\n"),
    status: items.some(({ status }) => status === "failed")
      ? "failed"
      : items.some(({ status }) => status === "running")
        ? "running"
        : "completed",
  };
}

type NormalizedBuildResponseTimelineInput = BuildResponseTimelineInput & {
  plans: AgentPlan[];
  approvals: AgentApprovalRequest[];
  inputRequests: AgentInputRequest[];
  gitArtifacts: TurnGitArtifactSummary[];
};

interface TimelineIndexes {
  userMessageById: Map<string, ChatMessage>;
  messagesByTurn: Map<string, ChatMessage[]>;
  activitiesByTurn: Map<string, AgentActivity[]>;
  reasoningsByTurn: Map<string, AgentReasoning[]>;
  plansByTurn: Map<string, AgentPlan[]>;
  approvalsByTurn: Map<string, AgentApprovalRequest[]>;
  inputRequestsByTurn: Map<string, AgentInputRequest[]>;
  checkpointById: Map<string, CheckpointSummary>;
  checkpointsByTurn: Map<string, CheckpointSummary[]>;
  gitArtifactByTurn: Map<string, TurnGitArtifactSummary>;
}

function groupByTurn<T extends { turnId: string | null }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    if (item.turnId === null) continue;
    const current = grouped.get(item.turnId);
    if (current) current.push(item);
    else grouped.set(item.turnId, [item]);
  }
  return grouped;
}

function indexTimeline(input: NormalizedBuildResponseTimelineInput): TimelineIndexes {
  return {
    userMessageById: new Map(input.messages
      .filter(({ role }) => role === "user")
      .map((message) => [message.id, message])),
    messagesByTurn: groupByTurn(input.messages),
    activitiesByTurn: groupByTurn(input.activities),
    reasoningsByTurn: groupByTurn(input.reasonings),
    plansByTurn: groupByTurn(input.plans),
    approvalsByTurn: groupByTurn(input.approvals),
    inputRequestsByTurn: groupByTurn(input.inputRequests),
    checkpointById: new Map(input.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint])),
    checkpointsByTurn: groupByTurn(input.checkpoints),
    gitArtifactByTurn: new Map(input.gitArtifacts.map((artifact) => [artifact.turnId, artifact])),
  };
}

function buildTurn(
  agentTurn: AgentTurn,
  index: number,
  indexes: TimelineIndexes,
): ResponseTurn | null {
  const userMessage = indexes.userMessageById.get(agentTurn.userMessageId);
  if (
    !userMessage
    || userMessage.conversationId !== agentTurn.conversationId
    || userMessage.turnId !== agentTurn.id
  ) return null;

  const scopedMessages = (indexes.messagesByTurn.get(agentTurn.id) ?? [])
    .filter((message) =>
      message.conversationId === agentTurn.conversationId
      && message.id !== userMessage.id)
    .sort(compareTimestamped);
  const assistantMessages = scopedMessages.filter(({ role }) => role === "assistant");
  const followUpMessages = scopedMessages.filter(({ role }) => role === "user");
  const terminalAssistantMessage = agentTurn.terminalAssistantMessageId === null
    ? null
    : assistantMessages.find(({ id }) => id === agentTurn.terminalAssistantMessageId) ?? null;
  const commentaryMessages = assistantMessages.filter(({ id }) =>
    id !== terminalAssistantMessage?.id);
  const systemMessages = scopedMessages.filter(({ role }) => role === "system");
  const activities = (indexes.activitiesByTurn.get(agentTurn.id) ?? [])
    .filter((activity) =>
      activity.conversationId === agentTurn.conversationId)
    .sort(compareTimestamped);
  const reasonings = (indexes.reasoningsByTurn.get(agentTurn.id) ?? [])
    .filter((reasoning) =>
      reasoning.conversationId === agentTurn.conversationId)
    .sort(compareTimestamped);
  const plans = (indexes.plansByTurn.get(agentTurn.id) ?? [])
    .filter((plan) => plan.conversationId === agentTurn.conversationId);
  const checkpoint = agentTurn.checkpointId
    ? (() => {
        const item = indexes.checkpointById.get(agentTurn.checkpointId!);
        return item?.conversationId === agentTurn.conversationId ? item : null;
      })()
    : (indexes.checkpointsByTurn.get(agentTurn.id) ?? [])
      .find((item) => item.conversationId === agentTurn.conversationId) ?? null;
  const importantActivities: AgentActivity[] = [];
  const foldableActivities: AgentActivity[] = [];
  for (const activity of activities) {
    (activityNeedsAttention(activity)
      ? importantActivities
      : foldableActivities).push(activity);
  }

  return {
    id: agentTurn.id,
    index,
    agentTurn,
    userMessage,
    followUpMessages,
    assistantMessages,
    commentaryMessages,
    terminalAssistantMessage,
    systemMessages,
    activities,
    reasonings,
    reasoning: latestReasoning(reasonings),
    plans,
    approvals: (indexes.approvalsByTurn.get(agentTurn.id) ?? [])
      .filter((request) => request.conversationId === agentTurn.conversationId),
    inputRequests: (indexes.inputRequestsByTurn.get(agentTurn.id) ?? [])
      .filter((request) => request.conversationId === agentTurn.conversationId),
    checkpoint,
    gitArtifact: indexes.gitArtifactByTurn.get(agentTurn.id) ?? null,
    requestedAt: agentTurn.requestedAt,
    startedAt: agentTurn.startedAt,
    completedAt: agentTurn.completedAt,
    isActive: !isAgentRunTerminalState(agentRunStateForTurn(agentTurn)),
    toolCallCount: activities.filter(({ kind }) =>
      kind === "tool" || kind === "command" || kind === "file").length,
    importantActivities,
    foldableActivities,
  };
}

export interface BuildResponseTimelineInput {
  turns: AgentTurn[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  reasonings: AgentReasoning[];
  plans?: AgentPlan[];
  approvals?: AgentApprovalRequest[];
  inputRequests?: AgentInputRequest[];
  checkpoints: CheckpointSummary[];
  gitArtifacts?: TurnGitArtifactSummary[];
}

/**
 * Builds normal history only from persisted turn rows and explicit ownership.
 *
 * Timestamps order already-owned records; they never decide ownership. Inferred
 * legacy turns and every null/unknown-owned record are quarantined in one
 * compatibility item instead of being attached to an authoritative turn.
 */
export function buildResponseTimeline(rawInput: BuildResponseTimelineInput): ResponseTimelineItem[] {
  const input: NormalizedBuildResponseTimelineInput = {
    ...rawInput,
    plans: rawInput.plans ?? [],
    approvals: rawInput.approvals ?? [],
    inputRequests: rawInput.inputRequests ?? [],
    gitArtifacts: rawInput.gitArtifacts ?? [],
  };
  const indexes = indexTimeline(input);
  const sortedTurns = [...input.turns].sort(compareTurns);
  const builtTurns = new Map<string, ResponseTurn>();
  const malformedTurns: AgentTurn[] = [];
  sortedTurns.forEach((agentTurn, index) => {
    const turn = buildTurn(agentTurn, index + 1, indexes);
    if (turn) builtTurns.set(agentTurn.id, turn);
    else malformedTurns.push(agentTurn);
  });

  const authoritativeTurns = sortedTurns.flatMap((agentTurn) => {
    const turn = builtTurns.get(agentTurn.id);
    return agentTurn.association === "authoritative" && turn ? [turn] : [];
  });
  const inferredTurns = sortedTurns.flatMap((agentTurn) => {
    const turn = builtTurns.get(agentTurn.id);
    return agentTurn.association === "inferred" && turn ? [turn] : [];
  });
  const claimedTurnIds = new Set(builtTurns.keys());
  const claimedMessageIds = new Set<string>();
  const claimedCheckpointIds = new Set<string>();
  for (const turn of builtTurns.values()) {
    claimedMessageIds.add(turn.userMessage.id);
    turn.followUpMessages.forEach(({ id }) => claimedMessageIds.add(id));
    turn.assistantMessages.forEach(({ id }) => claimedMessageIds.add(id));
    turn.systemMessages.forEach(({ id }) => claimedMessageIds.add(id));
    if (turn.checkpoint) claimedCheckpointIds.add(turn.checkpoint.id);
  }

  const compatibility: ResponseTimelineCompatibility = {
    inferredTurns,
    malformedTurns,
    messages: input.messages
      .filter(({ id }) => !claimedMessageIds.has(id))
      .sort(compareTimestamped),
    activities: input.activities
      .filter(({ turnId }) => turnId === null || !claimedTurnIds.has(turnId))
      .sort(compareTimestamped),
    reasonings: input.reasonings
      .filter(({ turnId }) => turnId === null || !claimedTurnIds.has(turnId))
      .sort(compareTimestamped),
    plans: input.plans.filter(({ turnId }) => turnId === null || !claimedTurnIds.has(turnId)),
    checkpoints: input.checkpoints
      .filter(({ id, turnId }) =>
        !claimedCheckpointIds.has(id)
        && (turnId === null || !claimedTurnIds.has(turnId)))
      .sort(compareTimestamped),
  };
  const hasCompatibility = compatibility.inferredTurns.length > 0
    || compatibility.malformedTurns.length > 0
    || compatibility.messages.length > 0
    || compatibility.activities.length > 0
    || compatibility.reasonings.length > 0
    || compatibility.plans.length > 0
    || compatibility.checkpoints.length > 0;

  return [
    ...(hasCompatibility
      ? [{
          kind: "compatibility" as const,
          id: "legacy-orphan-history" as const,
          compatibility,
        }]
      : []),
    ...authoritativeTurns.map((turn) => ({ kind: "turn" as const, id: turn.id, turn })),
  ];
}

/**
 * Rebuilds one authoritative turn when an activity projection is the only
 * changed timeline input. Live command/tool updates are the transcript's
 * highest-frequency durable mutation, so regrouping every historical record
 * for each update is avoidable work on long conversations.
 *
 * Returning null deliberately falls back to the complete builder whenever the
 * delta touches compatibility history, more than one turn, or an unowned
 * record. Truthful ownership is more important than taking the fast path.
 */
export function updateResponseTimelineForActivityDelta(
  input: BuildResponseTimelineInput,
  previousActivities: AgentActivity[],
  previousTimeline: ResponseTimelineItem[],
): ResponseTimelineItem[] | null {
  if (input.activities === previousActivities) return previousTimeline;
  const previousById = new Map(
    previousActivities.map((activity) => [activity.id, activity]),
  );
  const nextById = new Map(
    input.activities.map((activity) => [activity.id, activity]),
  );
  const changedTurnIds = new Set<string>();
  const recordChangedTurn = (
    activity: AgentActivity | undefined,
  ): boolean => {
    if (!activity || activity.turnId === null) return false;
    changedTurnIds.add(activity.turnId);
    return changedTurnIds.size <= 1;
  };
  for (const activity of input.activities) {
    const previous = previousById.get(activity.id);
    if (previous === activity) continue;
    if (!recordChangedTurn(activity)) return null;
    if (
      previous
      && previous.turnId !== activity.turnId
      && !recordChangedTurn(previous)
    ) return null;
  }
  for (const activity of previousActivities) {
    if (nextById.has(activity.id)) continue;
    if (!recordChangedTurn(activity)) return null;
  }
  if (changedTurnIds.size === 0) return previousTimeline;

  const turnId = [...changedTurnIds][0]!;
  const previousItem = previousTimeline.find(
    (item) => item.kind === "turn" && item.turn.id === turnId,
  );
  const agentTurn = input.turns.find(({ id }) => id === turnId);
  if (previousItem?.kind !== "turn" || !agentTurn) return null;

  const scoped = buildResponseTimeline({
    turns: [agentTurn],
    messages: input.messages.filter(({ turnId: owner }) => owner === turnId),
    activities: input.activities.filter(
      ({ turnId: owner }) => owner === turnId,
    ),
    reasonings: input.reasonings.filter(
      ({ turnId: owner }) => owner === turnId,
    ),
    plans: input.plans?.filter(({ turnId: owner }) => owner === turnId),
    approvals: input.approvals?.filter(({ turnId: owner }) => owner === turnId),
    inputRequests: input.inputRequests?.filter(
      ({ turnId: owner }) => owner === turnId,
    ),
    checkpoints: input.checkpoints.filter(
      ({ id, turnId: owner }) =>
        owner === turnId || id === agentTurn.checkpointId,
    ),
    gitArtifacts: input.gitArtifacts?.filter(
      ({ turnId: owner }) => owner === turnId,
    ),
  });
  const rebuilt = scoped.length === 1 && scoped[0]?.kind === "turn"
    ? scoped[0]
    : null;
  if (!rebuilt) return null;
  const replacement: ResponseTimelineItem = {
    ...rebuilt,
    turn: {
      ...rebuilt.turn,
      index: previousItem.turn.index,
    },
  };
  return previousTimeline.map((item) =>
    item.id === turnId ? replacement : item);
}

function sameReferences<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameResponseTurn(left: ResponseTurn, right: ResponseTurn): boolean {
  return left.id === right.id
    && left.index === right.index
    && left.agentTurn === right.agentTurn
    && left.userMessage === right.userMessage
    && left.terminalAssistantMessage === right.terminalAssistantMessage
    && left.checkpoint === right.checkpoint
    && left.gitArtifact === right.gitArtifact
    && left.requestedAt === right.requestedAt
    && left.startedAt === right.startedAt
    && left.completedAt === right.completedAt
    && left.isActive === right.isActive
    && left.toolCallCount === right.toolCallCount
    && sameReferences(left.followUpMessages, right.followUpMessages)
    && sameReferences(left.assistantMessages, right.assistantMessages)
    && sameReferences(left.commentaryMessages, right.commentaryMessages)
    && sameReferences(left.systemMessages, right.systemMessages)
    && sameReferences(left.activities, right.activities)
    && sameReferences(left.reasonings, right.reasonings)
    && sameReferences(left.plans, right.plans)
    && sameReferences(left.approvals, right.approvals)
    && sameReferences(left.inputRequests, right.inputRequests)
    && sameReferences(left.importantActivities, right.importantActivities)
    && sameReferences(left.foldableActivities, right.foldableActivities);
}

function stabilizeTurn(left: ResponseTurn | undefined, right: ResponseTurn): ResponseTurn {
  return left && sameResponseTurn(left, right) ? left : right;
}

function sameCompatibility(
  left: ResponseTimelineCompatibility,
  right: ResponseTimelineCompatibility,
): boolean {
  return sameReferences(left.inferredTurns, right.inferredTurns)
    && sameReferences(left.malformedTurns, right.malformedTurns)
    && sameReferences(left.messages, right.messages)
    && sameReferences(left.activities, right.activities)
    && sameReferences(left.reasonings, right.reasonings)
    && sameReferences(left.plans, right.plans)
    && sameReferences(left.checkpoints, right.checkpoints);
}

/**
 * Retains unchanged historical row objects across snapshots. Streaming content
 * is deliberately not part of these persisted rows, so an active row can
 * update without invalidating every settled turn.
 */
export function stabilizeResponseTimeline(
  next: ResponseTimelineItem[],
  previous: ResponseTimelineItem[],
): ResponseTimelineItem[] {
  if (previous.length === 0) return next;
  const previousById = new Map(previous.map((item) => [item.id, item]));
  let changed = next.length !== previous.length;
  const result = next.map((item, index) => {
    const prior = previousById.get(item.id);
    if (item.kind === "turn") {
      const turn = stabilizeTurn(prior?.kind === "turn" ? prior.turn : undefined, item.turn);
      const stable = prior?.kind === "turn" && turn === prior.turn ? prior : { ...item, turn };
      if (stable !== previous[index]) changed = true;
      return stable;
    }

    if (prior?.kind !== "compatibility") {
      changed = true;
      return item;
    }
    const inferredTurns = item.compatibility.inferredTurns.map((turn) => {
      const previousTurn = prior.compatibility.inferredTurns.find(({ id }) => id === turn.id);
      return stabilizeTurn(previousTurn, turn);
    });
    const compatibility = {
      ...item.compatibility,
      inferredTurns,
    };
    const stable = sameCompatibility(prior.compatibility, compatibility)
      ? prior
      : { ...item, compatibility };
    if (stable !== previous[index]) changed = true;
    return stable;
  });
  return changed ? result : previous;
}
