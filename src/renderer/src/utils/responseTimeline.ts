import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  AgentTurnStatus,
  ChatMessage,
  CheckpointSummary,
  InterfaceScale,
  ResponseDensity,
  TurnGitArtifact,
} from "@shared/contracts";

const TERMINAL_TURN_STATUSES: ReadonlySet<AgentTurnStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Current workspace status is intentionally not accepted by the timeline. */
export type TurnGitArtifactSummary = TurnGitArtifact;

export interface ResponseTurn {
  /** Stable persisted row identity for future virtualization. */
  id: string;
  index: number;
  agentTurn: AgentTurn;
  userMessage: ChatMessage;
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

export type ActivityAttentionSeverity = "warning" | "failure";

export function isInterruptedActivity(
  activity: Pick<AgentActivity, "title" | "detail" | "status">,
): boolean {
  return activity.status === "failed"
    && /\binterrupted\b/iu.test(`${activity.title} ${activity.detail ?? ""}`);
}

export function activityAttentionSeverity(
  activity: AgentActivity,
): ActivityAttentionSeverity | null {
  if (isInterruptedActivity(activity)) return "warning";
  if (activity.status === "failed" || activity.kind === "error") return "failure";
  return /\b(?:blocked|canceled|cancelled|incomplete|partial(?:ly)?|skipped|unsupported|warned|warning)\b/iu
    .test(`${activity.title} ${activity.detail ?? ""}`)
    ? "warning"
    : null;
}

export function activityNeedsAttention(activity: AgentActivity): boolean {
  return activityAttentionSeverity(activity) !== null;
}

export interface ActivityDetailPresentation {
  preview: string | null;
  full: string | null;
  expandable: boolean;
}

const MAX_ACTIVITY_DETAIL_PREVIEW_LINES = 3;
const MAX_ACTIVITY_DETAIL_PREVIEW_LINE_CHARS = 160;

/**
 * Raw provider detail remains bounded behind a disclosure. The transcript gets
 * at most three compact lines and never measures or paints the full payload
 * until the user intentionally expands it.
 */
export function activityDetailPresentation(
  activity: Pick<AgentActivity, "detail" | "kind" | "status">,
): ActivityDetailPresentation {
  const full = activity.detail?.replace(/\r\n?/gu, "\n").trim() || null;
  if (!full) return { preview: null, full: null, expandable: false };
  const lines = full
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, values) =>
      Boolean(line.trim()) || (index > 0 && index < values.length - 1));
  const previewLines = lines
    .slice(0, MAX_ACTIVITY_DETAIL_PREVIEW_LINES)
    .map((line) =>
      line.length > MAX_ACTIVITY_DETAIL_PREVIEW_LINE_CHARS
        ? `${line.slice(0, MAX_ACTIVITY_DETAIL_PREVIEW_LINE_CHARS - 1)}…`
        : line);
  const preview = previewLines.join("\n") || null;
  const technical = activity.kind === "command"
    || activity.kind === "tool"
    || activity.status === "failed"
    || full.length > MAX_ACTIVITY_DETAIL_PREVIEW_LINE_CHARS
    || lines.length > 1
    || /^(?:Command|Error|Output):/mu.test(full);
  return {
    preview,
    full,
    expandable: technical,
  };
}

export function isTranscriptActivity(activity: AgentActivity): boolean {
  return activity.kind === "tool"
    || activity.kind === "command"
    || activity.kind === "file"
    || activityNeedsAttention(activity);
}

export type TurnExecutionStreamEntry =
  | {
      kind: "commentary";
      id: string;
      createdAt: string;
      message: ChatMessage | null;
      content: string;
      streaming: boolean;
    }
  | {
      kind: "activity-group";
      id: string;
      createdAt: string;
      activities: AgentActivity[];
    };

export interface ActivityGroupPresentation {
  visibleActivities: AgentActivity[];
  hiddenCount: number;
}

/**
 * Keeps attention rows and the newest meaningful call visible when collapsed.
 * Expanded rows retain their authoritative created-time order.
 */
export function resolveActivityGroupPresentation(
  activities: AgentActivity[],
  expanded: boolean,
): ActivityGroupPresentation {
  let newestMeaningfulId: string | null = null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const candidate = activities[index]!;
    if (!activityNeedsAttention(candidate)) {
      newestMeaningfulId = candidate.id;
      break;
    }
  }
  const alwaysVisible = new Set(activities
    .filter((activity) =>
      activity.id === newestMeaningfulId
      || activityNeedsAttention(activity))
    .map(({ id }) => id));
  const hiddenCount = activities.filter(({ id }) => !alwaysVisible.has(id)).length;
  return {
    visibleActivities: expanded
      ? activities
      : activities.filter(({ id }) => alwaysVisible.has(id)),
    hiddenCount,
  };
}

interface BuildTurnExecutionStreamOptions {
  liveContent?: string;
  includeImportantActivities?: boolean;
}

/**
 * Builds the visible provider transcript in event order. Only adjacent work
 * entries are grouped; commentary and attention rows always break a group.
 */
export function buildTurnExecutionStream(
  turn: Pick<ResponseTurn, "id" | "agentTurn" | "commentaryMessages" | "activities">,
  options: BuildTurnExecutionStreamOptions = {},
): TurnExecutionStreamEntry[] {
  const includeImportant = options.includeImportantActivities ?? true;
  const items: Array<
    | {
        kind: "commentary";
        id: string;
        createdAt: string;
        message: ChatMessage | null;
        content: string;
        streaming: boolean;
        order: number;
      }
    | {
        kind: "activity";
        id: string;
        createdAt: string;
        activity: AgentActivity;
        order: number;
      }
  > = [];

  for (const message of turn.commentaryMessages) {
    items.push({
      kind: "commentary",
      id: message.id,
      createdAt: message.createdAt,
      message,
      content: message.content,
      streaming: false,
      order: 0,
    });
  }
  for (const activity of turn.activities) {
    if (!isTranscriptActivity(activity)) continue;
    if (!includeImportant && activityNeedsAttention(activity)) continue;
    items.push({
      kind: "activity",
      id: activity.id,
      createdAt: activity.createdAt,
      activity,
      order: 1,
    });
  }
  if (options.liveContent) {
    items.push({
      kind: "commentary",
      id: `live-commentary:${turn.id}`,
      createdAt: turn.agentTurn.updatedAt,
      message: null,
      content: options.liveContent,
      streaming: true,
      order: 2,
    });
  }
  items.sort((left, right) =>
    Number(left.kind === "commentary" && left.streaming)
      - Number(right.kind === "commentary" && right.streaming)
    ||
    timestamp(left.createdAt) - timestamp(right.createdAt)
    || left.order - right.order
    || left.id.localeCompare(right.id));

  const stream: TurnExecutionStreamEntry[] = [];
  for (const item of items) {
    if (item.kind === "commentary") {
      stream.push(item);
      continue;
    }
    const previous = stream.at(-1);
    const needsAttention = activityNeedsAttention(item.activity);
    if (
      !needsAttention
      && previous?.kind === "activity-group"
      && previous.activities.every((activity) => !activityNeedsAttention(activity))
    ) {
      previous.activities.push(item.activity);
      continue;
    }
    stream.push({
      kind: "activity-group",
      id: `activity-group:${item.id}`,
      createdAt: item.createdAt,
      activities: [item.activity],
    });
  }
  return stream;
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function boundedElapsed(startedAt: string, completedAt: string | null, now: number): number {
  const start = timestamp(startedAt);
  const end = completedAt ? timestamp(completedAt) : now;
  return Math.max(0, end - start);
}

/** Persisted requested → started queue time. A queued turn remains live. */
export function turnQueueElapsedMs(
  turn: Pick<ResponseTurn, "requestedAt" | "startedAt" | "completedAt" | "isActive">,
  now = Date.now(),
): number {
  if (turn.startedAt) return boundedElapsed(turn.requestedAt, turn.startedAt, now);
  if (turn.completedAt) return boundedElapsed(turn.requestedAt, turn.completedAt, now);
  return turn.isActive ? boundedElapsed(turn.requestedAt, null, now) : 0;
}

/**
 * Persisted started → completed execution time. Live work may use `now`; a
 * terminal row without a persisted completion never acquires a drifting
 * historical duration.
 */
export function turnExecutionElapsedMs(
  turn: Pick<ResponseTurn, "startedAt" | "completedAt" | "isActive">,
  now = Date.now(),
): number | null {
  if (!turn.startedAt) return null;
  if (!turn.completedAt && !turn.isActive) return null;
  return boundedElapsed(turn.startedAt, turn.completedAt, now);
}

/** Backward-compatible alias: elapsed work never includes queue time. */
export function turnElapsedMs(
  turn: Pick<ResponseTurn, "startedAt" | "completedAt" | "isActive">,
  now = Date.now(),
): number {
  return turnExecutionElapsedMs(turn, now) ?? 0;
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
  const importantActivities = activities.filter(activityNeedsAttention);

  return {
    id: agentTurn.id,
    index,
    agentTurn,
    userMessage,
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
    isActive: !TERMINAL_TURN_STATUSES.has(agentTurn.status),
    toolCallCount: activities.filter(({ kind }) =>
      kind === "tool" || kind === "command" || kind === "file").length,
    importantActivities,
    foldableActivities: activities.filter((activity) => !activityNeedsAttention(activity)),
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

export const TIMELINE_VIRTUALIZATION_MIN_ROWS = 40;
export const TIMELINE_MINIMAP_MIN_GUTTER = 48;
export const TIMELINE_MINIMAP_MAX_MARKERS = 48;

export function shouldVirtualizeTimeline(rowCount: number): boolean {
  return Number.isFinite(rowCount) && rowCount >= TIMELINE_VIRTUALIZATION_MIN_ROWS;
}

export function shouldShowTimelineMinimap(rowCount: number, sideGutter: number): boolean {
  return shouldVirtualizeTimeline(rowCount)
    && Number.isFinite(sideGutter)
    && sideGutter >= TIMELINE_MINIMAP_MIN_GUTTER;
}

export function shouldShowTurnGitArtifactSummary(
  artifact: TurnGitArtifactSummary,
): boolean {
  return !(
    artifact.status === "unavailable"
    && artifact.completeness === "unavailable"
    && artifact.absenceReason === "not-repository"
  );
}

export interface TimelineRowEstimateOptions {
  /** Current transcript width in CSS pixels. Narrow/zoomed layouts wrap sooner. */
  availableWidth?: number;
  /** Persisted interface scale controls transcript column width and typography. */
  interfaceScale?: InterfaceScale;
  /** Response density controls answer leading and inter-turn spacing. */
  responseDensity?: ResponseDensity;
  /** Matches the persisted "Collapse completed work logs" presentation setting. */
  workDetailsExpanded?: boolean;
  /** Models the additional rows revealed by expanded tool-call groups. */
  activityGroupsExpanded?: boolean;
  /** Mirrors whether reasoning summaries are visible inside work details. */
  showThinking?: boolean;
  /** Mirrors whether the changed-file disclosure is enabled and renderable. */
  showChangedFiles?: boolean;
  /** Used when an already-expanded metadata disclosure must be re-estimated. */
  runDetailsExpanded?: boolean;
  /** Used when an already-expanded changed-file disclosure must be re-estimated. */
  changedFilesExpanded?: boolean;
}

function boundedEstimateWidth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 880;
  return Math.max(320, Math.min(880, value));
}

function estimateTypographyScale(options: TimelineRowEstimateOptions): number {
  const baseFont = {
    compact: 12.5,
    default: 13.5,
    comfortable: 14.5,
    large: 16,
  }[options.interfaceScale ?? "default"];
  const densityAdjustment = {
    compact: 0.5,
    default: 1.5,
    comfortable: 2.5,
  }[options.responseDensity ?? "default"];
  const lineHeight = {
    compact: 1.6,
    default: 1.66,
    comfortable: 1.72,
  }[options.responseDensity ?? "default"];
  return Math.max(0.84, Math.min(1.28, ((baseFont + densityAdjustment) / 15) * (lineHeight / 1.66)));
}

function estimateAnswerMaxWidth(scale: InterfaceScale | undefined): number {
  if (scale === "compact") return 720;
  if (scale === "comfortable" || scale === "large") return 780;
  return 760;
}

function estimateRequestMaxWidth(scale: InterfaceScale | undefined): number {
  if (scale === "compact") return 640;
  if (scale === "comfortable") return 700;
  if (scale === "large") return 720;
  return 680;
}

function estimateTurnGap(density: ResponseDensity | undefined): number {
  if (density === "compact") return 28;
  if (density === "comfortable") return 44;
  return 36;
}

export function estimateCompletedTurnSpacing(
  density: ResponseDensity | undefined,
): {
  layer: number;
  footer: number;
  artifact: number;
} {
  if (density === "compact") {
    return { layer: 10, footer: 6, artifact: 1 };
  }
  if (density === "comfortable") {
    return { layer: 15, footer: 10, artifact: 3 };
  }
  return { layer: 12, footer: 8, artifact: 2 };
}

function estimateResponseBlockGap(density: ResponseDensity | undefined): number {
  if (density === "compact") return 13;
  if (density === "comfortable") return 22;
  return 18;
}

function estimatedTextColumns(width: number, maximum: number): number {
  return Math.max(30, Math.min(maximum, Math.floor(width / 7.6)));
}

function estimatedColumnLength(value: string): number {
  let columns = 0;
  for (const character of value) {
    if (character === "\t") {
      columns += 4;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    columns += codePoint > 0x2e7f ? 2 : 1;
  }
  return columns;
}

function estimatedWrappedLines(value: string, columns: number): number {
  if (!value) return 0;
  return value.replace(/\r/gu, "").split("\n").reduce((total, line) =>
    total + Math.max(1, Math.ceil(estimatedColumnLength(line) / columns)), 0);
}

function estimateMarkdownHeight(content: string, columns: number): number {
  if (!content.trim()) return 0;
  const blocks: number[] = [];
  const paragraph: string[] = [];
  let codeLines = 0;
  let inFence = false;
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const lines = estimatedWrappedLines(paragraph.join(" "), columns);
    blocks.push(Math.max(25, lines * 25));
    paragraph.length = 0;
  };
  const flushCode = (): void => {
    if (codeLines === 0) return;
    blocks.push(Math.min(4_800, 18 + codeLines * 20));
    codeLines = 0;
  };

  for (const rawLine of content.replace(/\r/gu, "").split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (/^(?:```|~~~)/u.test(trimmed)) {
      flushParagraph();
      codeLines += 1;
      inFence = !inFence;
      if (!inFence) flushCode();
      continue;
    }
    if (inFence) {
      codeLines += 1;
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      continue;
    }
    if (/^#{1,6}\s/u.test(trimmed)) {
      flushParagraph();
      blocks.push(Math.max(30, estimatedWrappedLines(trimmed.replace(/^#{1,6}\s+/u, ""), columns) * 30));
      continue;
    }
    if (/^(?:[-+*]|\d+[.)])\s/u.test(trimmed)) {
      flushParagraph();
      blocks.push(Math.max(25, estimatedWrappedLines(trimmed.replace(/^(?:[-+*]|\d+[.)])\s+/u, ""), columns - 4) * 25));
      continue;
    }
    if (/^>/u.test(trimmed)) {
      flushParagraph();
      blocks.push(18 + estimatedWrappedLines(trimmed.replace(/^>\s?/u, ""), columns - 4) * 25);
      continue;
    }
    if (/^\|.*\|$/u.test(trimmed)) {
      flushParagraph();
      blocks.push(Math.max(28, estimatedWrappedLines(trimmed, columns) * 28));
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushCode();
  const contentHeight = blocks.reduce((total, height) => total + height, 0);
  return Math.min(12_000, contentHeight + Math.max(0, blocks.length - 1) * 12);
}

function estimateApprovalHeight(
  approval: AgentApprovalRequest,
  columns: number,
): number {
  const commandHeight = approval.command
    ? Math.min(136, 16 + estimatedWrappedLines(approval.command, Math.max(24, columns - 8)) * 14)
    : approval.detail
      ? estimatedWrappedLines(approval.detail, columns) * 14
      : 0;
  const detailRows = Number(Boolean(approval.reason))
    + Number(Boolean(approval.cwd))
    + Number(Boolean(approval.networkScope))
    + Number(approval.permissionRoots.length > 0);
  return 82 + commandHeight + detailRows * 15;
}

function estimateInputRequestHeight(
  request: AgentInputRequest,
  columns: number,
): number {
  const questionsHeight = request.questions.reduce((total, question) => {
    const legendLines = estimatedWrappedLines(`${question.header} ${question.question}`, columns);
    const optionsHeight = question.options.reduce((optionTotal, option) =>
      optionTotal + 30 + Math.max(0, estimatedWrappedLines(option.description, columns - 8) - 1) * 12, 0);
    const inputHeight = question.options.length === 0 || question.isOther ? 38 : 0;
    return total + 20 + legendLines * 14 + optionsHeight + inputHeight;
  }, 0);
  return 82 + questionsHeight + (request.autoResolutionMs === null ? 0 : 20);
}

function estimateActivityGroupHeight(
  activities: AgentActivity[],
  expanded: boolean,
): number {
  const presentation = resolveActivityGroupPresentation(activities, expanded);
  const detailHeight = presentation.visibleActivities.reduce((total, activity) => {
    const detail = activityDetailPresentation(activity);
    if (!detail.expandable || !detail.preview) return total;
    const previewLines = Math.min(
      MAX_ACTIVITY_DETAIL_PREVIEW_LINES,
      detail.preview.split("\n").length,
    );
    return total + previewLines * 18 + 23;
  }, 0);
  return presentation.visibleActivities.length * 27
    + (presentation.hiddenCount > 0 ? 23 : 0)
    + detailHeight;
}

function estimateExpandedWorkHeight(
  turn: ResponseTurn,
  columns: number,
  includeReasoning: boolean,
  expandActivityGroups: boolean,
): number {
  const streamHeight = turn.isActive
    ? 0
    : buildTurnExecutionStream(turn).reduce((total, entry) => {
        if (entry.kind === "commentary") {
          return total + 10 + estimatedWrappedLines(entry.content, columns) * 18;
        }
        return total + estimateActivityGroupHeight(entry.activities, expandActivityGroups);
      }, 0);
  const reasoningHeight = includeReasoning && turn.reasoning
    ? 22 + estimatedWrappedLines(turn.reasoning.content, columns) * 18
    : 0;
  const planHeight = turn.plans.reduce((total, plan) =>
    total + 26
      + estimatedWrappedLines(plan.explanation ?? "", columns) * 17
      + plan.steps.length * 24, 0);
  return Math.min(6_000, streamHeight + reasoningHeight + planHeight);
}

function estimateRunDetailsHeight(
  turn: ResponseTurn,
  availableWidth: number,
): number {
  const artifactDetailVisible = turn.gitArtifact === null
    || shouldShowTurnGitArtifactSummary(turn.gitArtifact);
  const detailCount = 11 + Number(artifactDetailVisible);
  if (availableWidth <= 440) {
    return 8 + detailCount * 38 + Math.max(0, detailCount - 1) * 8;
  }
  if (availableWidth <= 620) {
    return 8 + detailCount * 18 + Math.max(0, detailCount - 1) * 8;
  }
  const rows = Math.ceil(detailCount / 2);
  return 8 + rows * 18 + Math.max(0, rows - 1) * 8;
}

function estimateTurnRowSize(
  turn: ResponseTurn,
  options: TimelineRowEstimateOptions,
): number {
  const availableWidth = boundedEstimateWidth(options.availableWidth);
  const typographyScale = estimateTypographyScale(options);
  const answerWidth = Math.max(
    280,
    Math.min(estimateAnswerMaxWidth(options.interfaceScale), availableWidth - 40),
  );
  const answerColumns = estimatedTextColumns(answerWidth / typographyScale, 96);
  const requestWidth = Math.max(
    240,
    Math.min(estimateRequestMaxWidth(options.interfaceScale), availableWidth * 0.8),
  );
  const requestColumns = estimatedTextColumns((requestWidth - 28) / typographyScale, 86);

  const requestLines = Math.max(1, estimatedWrappedLines(turn.userMessage.content, requestColumns));
  const attachmentRows = Math.ceil(turn.userMessage.attachments.length / Math.max(1, Math.floor(requestWidth / 180)));
  const requestHeight = 42 + requestLines * 22 + attachmentRows * 25;

  const transcriptActivities = turn.activities.filter(isTranscriptActivity);
  const activeActivityGroups = turn.isActive
    ? buildTurnExecutionStream(turn)
      .filter((entry): entry is Extract<TurnExecutionStreamEntry, { kind: "activity-group" }> =>
        entry.kind === "activity-group")
    : [];
  const collapsedActivityHeight = activeActivityGroups.reduce((total, entry) =>
    total + estimateActivityGroupHeight(
      entry.activities,
      options.activityGroupsExpanded === true,
    ), 0);
  const activeCommentaryHeight = turn.commentaryMessages.reduce((total, message) =>
    total + 12 + estimatedWrappedLines(message.content, answerColumns) * 18, 0);
  const includesReasoning = options.showThinking !== false && Boolean(turn.reasoning);
  const hasSupplementalWork = turn.plans.length > 0 || includesReasoning;
  // Attention rows use the same bounded preview/disclosure geometry as their
  // rendered ActivityRow instead of a generic status-row approximation.
  const importantHeight = turn.importantActivities.reduce((total, activity) =>
    total + estimateActivityGroupHeight([activity], true), 0);
  const consolidatesSettledWork = shouldConsolidateSettledWorkIntoRunDetails(turn);
  const executionHeight = turn.isActive
    ? 43
      + activeCommentaryHeight
      + collapsedActivityHeight
      + (hasSupplementalWork ? 27 : 0)
    : consolidatesSettledWork
      ? 0
      : 30 + importantHeight;
  const expandedWorkHeight = (
    options.workDetailsExpanded
      || (consolidatesSettledWork && options.runDetailsExpanded)
  )
    && (transcriptActivities.length > 0
      || turn.commentaryMessages.length > 0
      || hasSupplementalWork)
    ? estimateExpandedWorkHeight(
        turn,
        answerColumns,
        includesReasoning,
        options.activityGroupsExpanded === true,
      )
    : 0;
  const exceptionalHeight = turn.approvals.reduce((total, approval) =>
    total + estimateApprovalHeight(approval, answerColumns), 0)
    + turn.inputRequests.reduce((total, request) =>
      total + estimateInputRequestHeight(request, answerColumns), 0);

  const systemHeight = turn.systemMessages.reduce((total, message) =>
    total + 35 + estimatedWrappedLines(message.content, answerColumns) * 20, 0);
  const answerContent = turn.terminalAssistantMessage?.content ?? "";
  const answerHeight = answerContent
    ? 26 + estimateMarkdownHeight(answerContent, answerColumns)
    : 0;
  const metadataHeight = turn.terminalAssistantMessage
    ? 37 + (options.runDetailsExpanded
      ? estimateRunDetailsHeight(turn, availableWidth)
      : 0)
    : 0;

  const artifact = turn.gitArtifact;
  const visibleArtifact = options.showChangedFiles !== false
    && artifact !== null
    && shouldShowTurnGitArtifactSummary(artifact)
    ? artifact
    : null;
  const changedFilesHeight = visibleArtifact
    ? visibleArtifact.status === "unavailable"
      || visibleArtifact.status === "failed"
      || visibleArtifact.completeness === "unavailable"
      ? 32 + Math.max(
          18,
          estimatedWrappedLines(
            visibleArtifact.failureReason
              ?? "No authoritative Git snapshot was captured for this turn.",
            answerColumns,
          ) * 18,
        )
      : 33 + (options.changedFilesExpanded
        ? Math.min(12, visibleArtifact.files.length) * 28
          + (visibleArtifact.completeness === "complete" ? 0 : 35)
          + 38
        : 0)
    : 0;
  const consolidatedWorkHeight = consolidatesSettledWork
    ? expandedWorkHeight
    : 0;
  const executionSectionHeight = executionHeight
    + (consolidatesSettledWork ? 0 : expandedWorkHeight)
    + exceptionalHeight
    + systemHeight;
  const orderedSections = [
    { kind: "request", height: requestHeight },
    { kind: "execution", height: executionSectionHeight },
    { kind: "answer", height: answerHeight },
    {
      kind: "metadata",
      height: metadataHeight + consolidatedWorkHeight,
    },
    { kind: "artifact", height: changedFilesHeight },
  ].filter(({ height }) => height > 0);
  const settledSpacing = estimateCompletedTurnSpacing(options.responseDensity);
  const sectionSpacing = orderedSections.slice(1).reduce((total, section, index) => {
    const previous = orderedSections[index]!;
    if (turn.isActive) {
      return total + estimateResponseBlockGap(options.responseDensity);
    }
    if (previous.kind === "answer" && section.kind === "metadata") {
      return total + settledSpacing.footer;
    }
    if (previous.kind === "metadata" && section.kind === "artifact") {
      return total + settledSpacing.artifact;
    }
    return total + settledSpacing.layer;
  }, 0);
  const virtualRowGap = estimateTurnGap(options.responseDensity);

  const contentHeight = requestHeight
    + executionHeight
    + expandedWorkHeight
    + exceptionalHeight
    + systemHeight
    + answerHeight
    + metadataHeight
    + changedFilesHeight
    + sectionSpacing;
  return Math.max(
    Math.ceil((190 - 36) * typographyScale + virtualRowGap),
    Math.ceil(contentHeight * typographyScale + virtualRowGap),
  );
}

export function estimateTimelineRowSize(
  item: ResponseTimelineItem,
  options: TimelineRowEstimateOptions = {},
): number {
  if (item.kind === "compatibility") {
    const availableWidth = boundedEstimateWidth(options.availableWidth);
    const columns = estimatedTextColumns(Math.min(760, availableWidth - 40), 96);
    const inferredHeight = item.compatibility.inferredTurns.reduce((total, turn) =>
      total + estimateTurnRowSize(turn, options), 0);
    const messageHeight = item.compatibility.messages.reduce((total, message) =>
      total + 30 + estimatedWrappedLines(message.content, columns) * 20, 0);
    const recordHeight = (
      item.compatibility.malformedTurns.length
      + item.compatibility.activities.length
      + item.compatibility.reasonings.length
      + item.compatibility.plans.length
      + item.compatibility.checkpoints.length
    ) * 30;
    return Math.max(240, Math.ceil(Math.min(12_000, 100 + inferredHeight + messageHeight + recordHeight)));
  }
  const turn = item.turn;
  return estimateTurnRowSize(turn, options);
}

export interface TimelineMinimapMarker {
  index: number;
  id: string;
  label: string;
}

export function buildTimelineMinimapMarkers(
  turns: ResponseTurn[],
  maximum = TIMELINE_MINIMAP_MAX_MARKERS,
): TimelineMinimapMarker[] {
  if (turns.length === 0 || maximum <= 0) return [];
  const count = Math.min(turns.length, Math.max(2, Math.floor(maximum)));
  const indexes = new Set<number>();
  for (let marker = 0; marker < count; marker += 1) {
    indexes.add(Math.round(marker * (turns.length - 1) / Math.max(1, count - 1)));
  }
  return [...indexes].map((index) => {
    const turn = turns[index]!;
    const request = turn.userMessage.content.replace(/\s+/gu, " ").trim();
    return {
      index,
      id: turn.id,
      label: request.length > 72 ? `${request.slice(0, 69)}…` : request || `Turn ${turn.index}`,
    };
  });
}

export interface TimelineKeyboardIntent {
  index: number;
  target: "turn" | "request" | "final" | "artifact";
}

export function resolveTimelineKeyboardIntent(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  currentIndex: number,
  rowCount: number,
): TimelineKeyboardIntent | null {
  if (
    rowCount <= 0
    || !event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) return null;
  const current = Math.max(0, Math.min(currentIndex, rowCount - 1));
  if (event.key === "ArrowUp") return { index: Math.max(0, current - 1), target: "turn" };
  if (event.key === "ArrowDown") return { index: Math.min(rowCount - 1, current + 1), target: "turn" };
  if (event.key === "Home") return { index: current, target: "request" };
  if (event.key === "End") return { index: current, target: "final" };
  if (event.key.toLowerCase() === "g") return { index: current, target: "artifact" };
  return null;
}

export function shouldFollowTimeline(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 120): boolean {
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) return true;
  return Math.max(0, scrollHeight - clientHeight - scrollTop) <= threshold;
}

export interface TimelineSizeChangeAnchor {
  itemStart: number;
  itemSize: number;
  scrollOffset: number;
  firstMeasurement: boolean;
  scrollDirection: "forward" | "backward" | null;
  manuallyAnchored: boolean;
}

/**
 * Mirrors the virtualizer's stable-scroll policy while allowing an explicit
 * disclosure anchor to own one row's compensation. First measurements above
 * the fold correct estimate error. Later growth only shifts the viewport when
 * the entire row is above it; a streaming row spanning the fold and backward
 * user scrolling must remain stationary.
 */
export function shouldAdjustTimelineScrollPosition(
  input: TimelineSizeChangeAnchor,
): boolean {
  if (input.manuallyAnchored) return false;
  if (input.firstMeasurement) return input.itemStart < input.scrollOffset;
  return input.itemStart + input.itemSize <= input.scrollOffset
    && input.scrollDirection !== "backward";
}

export function turnStatusLabel(status: AgentTurnStatus): string {
  switch (status) {
    case "queued": return "Queued";
    case "starting": return "Starting";
    case "running": return "Working";
    case "waiting-for-approval": return "Waiting for approval";
    case "waiting-for-input": return "Waiting for input";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
  }
}

export function workSummaryLabel(turn: ResponseTurn, now = Date.now()): string {
  const execution = turnExecutionElapsedMs(turn, now);
  const duration = execution === null ? null : formatElapsed(execution);
  if (turn.agentTurn.status === "completed" && turn.toolCallCount === 0) {
    return "Completed without tool activity";
  }
  const prefix = turn.agentTurn.status === "failed"
    ? duration
      ? `Failed after ${duration}`
      : turn.startedAt
        ? "Failed"
        : "Failed before starting"
    : turn.agentTurn.status === "cancelled" || turn.agentTurn.status === "interrupted"
      ? duration
        ? `Stopped after ${duration}`
        : turn.startedAt
          ? "Stopped"
          : "Stopped before starting"
      : turn.agentTurn.status === "queued"
        ? `Queued for ${formatElapsed(turnQueueElapsedMs(turn, now))}`
        : duration
          ? `${turn.isActive ? "Working" : "Worked"} for ${duration}`
          : turnStatusLabel(turn.agentTurn.status);
  const actions = turn.toolCallCount;
  return actions > 0
    ? `${prefix} · ${actions} ${actions === 1 ? "action" : "actions"}`
    : prefix;
}

export function turnTimingLabels(turn: ResponseTurn, now = Date.now()): string[] {
  const queue = `Queued ${formatElapsed(turnQueueElapsedMs(turn, now))}`;
  const execution = turnExecutionElapsedMs(turn, now);
  const status = turn.agentTurn.status;
  if (execution === null) {
    if (turn.isActive) return [queue];
    if (status === "failed") {
      return [queue, turn.startedAt ? "Failed" : "Failed before starting"];
    }
    if (status === "cancelled" || status === "interrupted") {
      return [queue, turn.startedAt ? "Stopped" : "Stopped before starting"];
    }
    return [queue, turnStatusLabel(status)];
  }
  const work = status === "failed"
    ? `Failed after ${formatElapsed(execution)}`
    : status === "cancelled" || status === "interrupted"
      ? `Stopped after ${formatElapsed(execution)}`
      : `${turn.isActive ? "Working" : "Worked"} ${formatElapsed(execution)}`;
  return [queue, work];
}
