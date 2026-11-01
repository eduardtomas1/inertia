import type { SubagentTrace } from "@shared/contracts";
import { middleTruncate } from "./fileChipReference";
import { subagentTraceLabel } from "./subagentDisclosure";

export interface TurnAgentStatus {
  live: number;
  waiting: number;
  queued: number;
  total: number;
  done: number;
  stopped: number;
  failed: number;
  review: number;
}

export type SubagentTone =
  | "working"
  | "waiting"
  | "queued"
  | "done"
  | "stopped"
  | "failed"
  | "review";

const FAILED_STATUSES: ReadonlySet<SubagentTrace["status"]> = new Set(["failed", "interrupted", "lost"]);

export function subagentTone(trace: Pick<SubagentTrace, "isLive" | "status">): SubagentTone {
  if (trace.isLive) {
    if (trace.status === "waiting") return "waiting";
    return trace.status === "queued" ? "queued" : "working";
  }
  if (FAILED_STATUSES.has(trace.status)) return "failed";
  if (trace.status === "unknown") return "review";
  return trace.status === "cancelled" ? "stopped" : "done";
}

const STATUS_KEYS: Record<SubagentTone, Exclude<keyof TurnAgentStatus, "total">> = {
  working: "live",
  waiting: "waiting",
  queued: "queued",
  done: "done",
  stopped: "stopped",
  failed: "failed",
  review: "review",
};

export function turnAgentStatus(traces: readonly SubagentTrace[]): TurnAgentStatus | null {
  if (traces.length === 0) return null;
  const status: TurnAgentStatus = {
    live: 0,
    waiting: 0,
    queued: 0,
    total: traces.length,
    done: 0,
    stopped: 0,
    failed: 0,
    review: 0,
  };
  for (const trace of traces) status[STATUS_KEYS[subagentTone(trace)]] += 1;
  return status;
}

export function subagentGroupNeedsReview(status: TurnAgentStatus): boolean {
  return status.failed + status.review > 0;
}

export function subagentGroupFoldable(status: TurnAgentStatus | null): boolean {
  return status !== null && status.live === 0 && !subagentGroupNeedsReview(status);
}

export function subagentGroupSettledDone(status: TurnAgentStatus): boolean {
  return status.total > 0 && status.done === status.total;
}

function sameCollapsedTrace(left: SubagentTrace, right: SubagentTrace): boolean {
  return left === right || (
    left.id === right.id
    && left.status === right.status
    && left.isLive === right.isLive
    && left.providerId === right.providerId
    && left.createdAt === right.createdAt
    && left.durationMs === right.durationMs
    && (left.isLive || left.updatedAt === right.updatedAt)
  );
}

function samePanelTrace(left: SubagentTrace, right: SubagentTrace): boolean {
  return left === right || (
    sameCollapsedTrace(left, right)
    && left.providerName === right.providerName
    && left.providerRole === right.providerRole
    && left.description === right.description
    && left.progress === right.progress
    && left.result === right.result
  );
}

function sameTraces(
  previous: readonly SubagentTrace[] | undefined,
  next: readonly SubagentTrace[] | undefined,
  same: (left: SubagentTrace, right: SubagentTrace) => boolean,
): boolean {
  if (previous === next) return true;
  const left = previous ?? [];
  const right = next ?? [];
  return left.length === right.length
    && left.every((trace, index) => same(trace, right[index]!));
}

export function sameTurnAgentTraces(
  previous: readonly SubagentTrace[] | undefined,
  next: readonly SubagentTrace[] | undefined,
): boolean {
  return sameTraces(previous, next, sameCollapsedTrace);
}

export function sameSubagentPanelTraces(
  previous: readonly SubagentTrace[] | undefined,
  next: readonly SubagentTrace[] | undefined,
): boolean {
  return sameTraces(previous, next, samePanelTrace);
}

export function subagentCountLabel(total: number): string {
  return `${total} ${total === 1 ? "subagent" : "subagents"}`;
}

export interface TurnAgentStatusPart {
  tone: SubagentTone;
  text: string;
}

export function turnAgentStatusParts(status: TurnAgentStatus): TurnAgentStatusPart[] {
  return ([
    ["working", status.live, "working", "working"],
    ["waiting", status.waiting, "waiting", "waiting"],
    ["queued", status.queued, "queued", "queued"],
    ["done", status.done, "done", "done"],
    ["stopped", status.stopped, "stopped", "stopped"],
    ["failed", status.failed, "failed", "failed"],
    ["review", status.review, "needs review", "need review"],
  ] as const).flatMap(([tone, count, one, many]) =>
    count > 0 ? [{ tone, text: `${count} ${count === 1 ? one : many}` }] : []);
}

export function turnAgentStatusText(status: TurnAgentStatus): string {
  return turnAgentStatusParts(status).map(({ text }) => text).join(" · ");
}

const LIVE_WORDS: Partial<Record<SubagentTrace["status"], string>> = {
  queued: "Queued",
  waiting: "Waiting",
};

const SETTLED_WORDS: Partial<Record<SubagentTrace["status"], string>> = {
  completed: "Done",
  cancelled: "Stopped",
  failed: "Failed",
  interrupted: "Interrupted",
  lost: "Lost",
  unknown: "Needs review",
};

export function subagentStatusWord(trace: Pick<SubagentTrace, "isLive" | "status">): string {
  return trace.isLive
    ? LIVE_WORDS[trace.status] ?? "Working"
    : SETTLED_WORDS[trace.status] ?? "Finished";
}

export function subagentRowName(trace: SubagentTrace): string {
  return trace.providerName || trace.providerRole ? subagentTraceLabel(trace) : "Agent";
}

const MAX_DETAIL_CHARS = 280;
const MAX_PATH_CHARS = 40;
const PATH_LIKE = /[\\/]/u;

export function subagentRowDetail(
  trace: Pick<SubagentTrace, "isLive" | "progress" | "result" | "description">,
): string | null {
  const source = (trace.isLive && trace.progress?.trim()) || trace.result?.trim() || trace.description?.trim();
  if (!source) return null;
  const line = source
    .split(/\s+/u)
    .map((token) => token.length > MAX_PATH_CHARS && PATH_LIKE.test(token)
      ? middleTruncate(token, MAX_PATH_CHARS)
      : token)
    .join(" ");
  const characters = Array.from(line);
  return characters.length <= MAX_DETAIL_CHARS
    ? line
    : `${characters.slice(0, MAX_DETAIL_CHARS - 1).join("").trimEnd()}…`;
}

export interface SubagentGroupSpan {
  startedAt: number;
  endedAt: number | null;
}

function traceEnd(trace: SubagentTrace, startedAt: number): number {
  if (trace.durationMs !== null) return startedAt + trace.durationMs;
  return trace.status === "lost" ? Number.NaN : Date.parse(trace.updatedAt);
}

export function subagentGroupSpan(traces: readonly SubagentTrace[]): SubagentGroupSpan | null {
  let startedAt = Number.POSITIVE_INFINITY;
  let endedAt = Number.NEGATIVE_INFINITY;
  let live = false;
  for (const trace of traces) {
    const start = Date.parse(trace.createdAt);
    if (!Number.isFinite(start)) continue;
    startedAt = Math.min(startedAt, start);
    if (subagentTone(trace) === "working") live = true;
    else {
      const end = traceEnd(trace, start);
      if (Number.isFinite(end)) endedAt = Math.max(endedAt, end);
    }
  }
  if (!Number.isFinite(startedAt)) return null;
  if (live) return { startedAt, endedAt: null };
  return Number.isFinite(endedAt) ? { startedAt, endedAt } : null;
}

export function subagentGroupElapsedMs(span: SubagentGroupSpan, now: number): number {
  return Math.max(0, (span.endedAt ?? now) - span.startedAt);
}
