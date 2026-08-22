import type {
  AgentPlan,
  AgentTurn,
  AgentTurnStatus,
  AgentTurnTerminalStatus,
  ConversationDetailViewState,
  ConversationLatestTurnSummary,
  ConversationShell,
  SubagentTrace,
  ThreadUsageSnapshot,
} from "@shared/contracts";
import type { StreamingAgentChannel } from "./responseTimeline";

export type StreamingAgentState = [string, string, StreamingAgentChannel];
export const EMPTY_STREAMING_AGENT_STATE: StreamingAgentState = ["", "", null];

export function closeStreamingChannelState(
  [text, reasoning]: StreamingAgentState,
): StreamingAgentState {
  return [text, reasoning, null];
}

export function closeTextStreamState(
  [, reasoning]: StreamingAgentState,
): StreamingAgentState {
  return ["", reasoning, null];
}

export function appendStreamingText(
  [text, reasoning]: StreamingAgentState,
  chunk: string,
  limit: number,
): StreamingAgentState {
  return [`${text}${chunk}`.slice(-limit), reasoning, "text"];
}

export function appendStreamingReasoning(
  [text, reasoning]: StreamingAgentState,
  chunk: string,
  limit: number,
): StreamingAgentState {
  return [text, `${reasoning}${chunk}`.slice(-limit), "reasoning"];
}

export function sameAgentPlan(
  left: AgentPlan | null,
  right: AgentPlan,
): boolean {
  return left !== null
    && left.conversationId === right.conversationId
    && left.runId === right.runId
    && left.turnId === right.turnId
    && left.explanation === right.explanation
    && JSON.stringify(left.steps) === JSON.stringify(right.steps);
}

export function interactionKey(
  value: { conversationId: string; id: string },
): string {
  return `${value.conversationId}\0${value.id}`;
}

export function withoutHydratedBaseline<T extends { id: string }>(
  current: Record<string, T[]>,
  conversationId: string,
  baseline: readonly T[],
): Record<string, T[]> {
  const existing = current[conversationId];
  if (!existing || baseline.length === 0) return current;
  const baselineRecords = new Map(baseline.map((value) => [value.id, value]));
  const remaining = existing.filter((value) =>
    baselineRecords.get(value.id) !== value);
  if (remaining.length === existing.length) return current;
  const next = { ...current };
  if (remaining.length > 0) next[conversationId] = remaining;
  else delete next[conversationId];
  return next;
}

export function compareCreatedRecords(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): number {
  if (left.createdAt < right.createdAt) return -1;
  if (left.createdAt > right.createdAt) return 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function compareCreatedAt(
  left: { createdAt: string },
  right: { createdAt: string },
): number {
  return left.createdAt < right.createdAt
    ? -1
    : left.createdAt > right.createdAt
      ? 1
      : 0;
}

export function mergeProjectionRecords<T extends { id: string }>(
  persisted: readonly T[],
  live: readonly T[],
  compare: (left: T, right: T) => number,
): T[] {
  const merged = new Map(persisted.map((value) => [value.id, value]));
  for (const value of live) merged.set(value.id, value);
  return [...merged.values()].sort(compare);
}

export function mergeProjectionPlans(
  persisted: readonly AgentPlan[],
  live: AgentPlan | undefined,
): AgentPlan[] {
  const merged = new Map(persisted.map((plan) => [
    `${plan.runId}:${plan.turnId ?? "legacy"}`,
    plan,
  ]));
  if (live) merged.set(`${live.runId}:${live.turnId ?? "legacy"}`, live);
  return [...merged.values()];
}

export function compareSubagentTraces(
  left: SubagentTrace,
  right: SubagentTrace,
): number {
  return compareCreatedAt(left, right)
    || left.sequence - right.sequence
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function recordsForConversation<T extends { conversationId: string }>(
  records: readonly T[],
  conversationId: string | null | undefined,
): T[] {
  return conversationId
    ? records.filter((record) => record.conversationId === conversationId)
    : [];
}

export function projectionUsage(
  conversationId: string | null,
  live: Record<string, ThreadUsageSnapshot>,
  persisted: readonly ThreadUsageSnapshot[],
): ThreadUsageSnapshot | null {
  return conversationId
    ? live[conversationId]
      ?? persisted.find((usage) => usage.conversationId === conversationId)
      ?? null
    : null;
}

function isTerminalStatus(status: AgentTurnStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted";
}

export interface TerminalTurnProjection {
  owner: string;
  status: AgentTurnTerminalStatus;
  terminalReason: string | null;
}

export type TerminalTurnProjections = Record<string, TerminalTurnProjection>;

export function turnEventOwner(
  value: { runId: string; turnId: string },
): string {
  return `${value.runId}\0${value.turnId}`;
}

function turnOwner(value: { id: string; runId: string }): string {
  return `${value.runId}\0${value.id}`;
}

export function terminalEventMatchesCurrentTurn(input: {
  conversation: ConversationShell;
  detailState: ConversationDetailViewState | null;
  eventOwner: string;
  liveOwner: string | null;
}): boolean {
  const latestTurn = input.conversation.latestTurn;
  if (latestTurn && !isTerminalStatus(latestTurn.status)) {
    return turnOwner(latestTurn) === input.eventOwner;
  }
  if (input.liveOwner) return input.liveOwner === input.eventOwner;
  if (latestTurn) return false;
  if (input.detailState?.state !== "ready") return true;
  const activeTurns = input.detailState.detail.agentTurns.filter(({ status }) =>
    !isTerminalStatus(status));
  return activeTurns.length === 0
    || activeTurns.some((turn) => turnOwner(turn) === input.eventOwner);
}

export function withTerminalTurnProjection(
  current: TerminalTurnProjections,
  projection: TerminalTurnProjection,
): TerminalTurnProjections {
  return { ...current, [projection.owner]: projection };
}

export function reconcileTerminalTurnProjections(
  current: TerminalTurnProjections,
  turns: readonly AgentTurn[],
): TerminalTurnProjections {
  let next: TerminalTurnProjections | null = null;
  for (const turn of turns) {
    if (!isTerminalStatus(turn.status)) continue;
    const owner = turnOwner(turn);
    if (!current[owner]) continue;
    next ??= { ...current };
    delete next[owner];
  }
  return next ?? current;
}

export function projectConversationTerminal(
  conversation: ConversationShell | null,
  projections: TerminalTurnProjections,
): ConversationShell | null {
  const latestTurn = conversation?.latestTurn;
  if (!conversation || !latestTurn || isTerminalStatus(latestTurn.status)) {
    return conversation;
  }
  const projection = projections[turnOwner(latestTurn)];
  if (!projection) return conversation;
  return {
    ...conversation,
    status: projection.status === "completed"
      ? "completed"
      : projection.status === "cancelled"
        ? "idle"
        : "failed",
    attentionKind: null,
    latestTurn: {
      ...latestTurn,
      status: projection.status,
      runState: undefined,
      terminalReason: projection.terminalReason,
    },
  };
}

export function applyTerminalTurnProjections(
  turns: AgentTurn[],
  projections: TerminalTurnProjections,
  latestTurn: ConversationLatestTurnSummary | null,
): AgentTurn[] {
  if (Object.keys(projections).length === 0) return turns;
  return turns.map((turn) => {
    const projection = projections[turnOwner(turn)];
    if (!projection || isTerminalStatus(turn.status)) return turn;
    const settlement = latestTurn
      && turnOwner(latestTurn) === projection.owner
      && isTerminalStatus(latestTurn.status)
      ? latestTurn
      : null;
    return {
      ...turn,
      completedAt: settlement?.completedAt ?? turn.completedAt,
      status: settlement?.status ?? projection.status,
      runState: undefined,
      terminalReason: settlement
        ? settlement.terminalReason
        : projection.terminalReason,
      updatedAt: settlement?.updatedAt ?? turn.updatedAt,
    };
  });
}
