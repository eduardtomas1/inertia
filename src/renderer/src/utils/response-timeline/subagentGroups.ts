import type { SubagentTrace } from "@shared/contracts";
import { mergeSubagentCalls, type SubagentCallEntry } from "./subagentCalls";

/**
 * The delegated tasks a turn started at one point of its transcript. A group
 * sits where its tasks started, among the prose and tool calls around them,
 * and keeps that place while they run and after they finish.
 */
export interface SubagentGroupEntry {
  kind: "subagent-group";
  id: string;
  createdAt: string;
  turnId: string;
  /** Every task started here, in trace order; nested tasks stay with their root. */
  traces: SubagentTrace[];
  /** The ones with no timeline row of their own, drawn as compact rows. */
  compact: SubagentTrace[];
  /** Whether a settled turn's fold may hide this group. */
  foldable: boolean;
}

/** A turn's delegated work, placed into its transcript by `withDelegatedWork`. */
export interface DelegatedWork {
  /** Called custom agents, each drawn as its own block. */
  calls: readonly SubagentCallEntry[];
  /** Every other task of the turn, in trace order. */
  traces: readonly SubagentTrace[];
  /** The subset of `traces` drawn as compact rows. */
  compact: readonly SubagentTrace[];
  foldable: boolean;
}

export const NO_DELEGATED_WORK: DelegatedWork = { calls: [], traces: [], compact: [], foldable: false };

interface PlaceableEntry {
  createdAt: string;
  activities?: readonly { id: string }[];
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rootTrace(trace: SubagentTrace, byId: ReadonlyMap<string, SubagentTrace>): SubagentTrace {
  const seen = new Set([trace.id]);
  let root = trace;
  while (root.parentTraceId) {
    const parent = byId.get(root.parentTraceId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    root = parent;
  }
  return root;
}

/**
 * The gap before stream entry `n` that a task opens in: right after the work
 * group holding the tool call that started it, or else before the first entry
 * that began at or after the task started.
 */
function startGap(
  trace: SubagentTrace,
  stream: readonly PlaceableEntry[],
  entryByActivityId: ReadonlyMap<string, number>,
): number {
  const linked = trace.activityId ? entryByActivityId.get(trace.activityId) : undefined;
  if (linked !== undefined) return linked + 1;
  const started = timestamp(trace.createdAt);
  const next = stream.findIndex((entry) => timestamp(entry.createdAt) >= started);
  return next < 0 ? stream.length : next;
}

/**
 * Places each delegated task where it started. Tasks that start with nothing
 * else in between share one group, as parallel agents do, and a task started
 * by another task stays in its parent's group.
 */
export function withSubagentGroups<T extends PlaceableEntry>(
  stream: readonly T[],
  work: Pick<DelegatedWork, "traces" | "compact" | "foldable">,
): Array<T | SubagentGroupEntry> {
  if (work.traces.length === 0) return stream as T[];
  const entryByActivityId = new Map<string, number>();
  stream.forEach((entry, index) => {
    entry.activities?.forEach(({ id }) => entryByActivityId.set(id, index));
  });
  const byId = new Map(work.traces.map((trace) => [trace.id, trace]));
  const compactIds = new Set(work.compact.map(({ id }) => id));
  const groups = new Map<number, SubagentGroupEntry>();
  for (const trace of work.traces) {
    const root = rootTrace(trace, byId);
    const gap = startGap(root, stream, entryByActivityId);
    const group = groups.get(gap) ?? {
      kind: "subagent-group" as const,
      id: `subagent-group:${root.id}`,
      createdAt: root.createdAt,
      turnId: root.turnId,
      traces: [],
      compact: [],
      foldable: work.foldable,
    };
    groups.set(gap, group);
    group.traces.push(trace);
    if (compactIds.has(trace.id)) group.compact.push(trace);
  }
  const placed: Array<T | SubagentGroupEntry> = [];
  for (let gap = 0; gap <= stream.length; gap += 1) {
    const group = groups.get(gap);
    if (group) placed.push(group);
    if (gap < stream.length) placed.push(stream[gap]!);
  }
  return placed;
}

export function withDelegatedWork<T extends PlaceableEntry>(
  stream: readonly T[],
  work: DelegatedWork,
): Array<T | SubagentCallEntry | SubagentGroupEntry> {
  return withSubagentGroups(mergeSubagentCalls(stream, work.calls), work);
}
