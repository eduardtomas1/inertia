import type { AgentTurnStatus } from "@shared/contracts";
import type { ResponseTurn } from "./model";

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatElapsed(milliseconds: number, precise = false): string {
  if (precise) {
    const tenths = Math.floor(Math.max(0, milliseconds) / 100);
    const minutes = Math.floor(tenths / 600);
    const seconds = ((tenths % 600) / 10).toFixed(1);
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }
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
  turn: Pick<ResponseTurn, "startedAt" | "completedAt" | "isActive" | "agentTurn">,
  now = Date.now(),
): number | null {
  if (!turn.startedAt) return null;
  if (!turn.completedAt && !turn.isActive) return null;
  const suspendedDuration = turn.agentTurn.suspendedDurationMs ?? 0;
  if (!Number.isSafeInteger(suspendedDuration) || suspendedDuration < 0) {
    return null;
  }
  return Math.max(
    0,
    boundedElapsed(turn.startedAt, turn.completedAt, now) - suspendedDuration,
  );
}

/** Backward-compatible alias: elapsed work never includes queue time. */
export function turnElapsedMs(
  turn: Pick<ResponseTurn, "startedAt" | "completedAt" | "isActive" | "agentTurn">,
  now = Date.now(),
): number {
  return turnExecutionElapsedMs(turn, now) ?? 0;
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
