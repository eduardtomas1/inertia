import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { SubagentTrace } from "@shared/contracts";

const latest = new Map<string, readonly SubagentTrace[]>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishTurnSubagents(
  byTurn: ReadonlyMap<string, readonly SubagentTrace[]>,
  previous: ReadonlyMap<string, readonly SubagentTrace[]>,
): void {
  let changed = false;
  for (const [turnId, traces] of previous) {
    if (byTurn.has(turnId) || latest.get(turnId) !== traces) continue;
    latest.delete(turnId);
    changed = true;
  }
  for (const [turnId, traces] of byTurn) {
    if (latest.get(turnId) === traces) continue;
    latest.set(turnId, traces);
    changed = true;
  }
  if (changed) listeners.forEach((listener) => listener());
}

function groupByTurn(
  subagents: readonly SubagentTrace[],
  previous: ReadonlyMap<string, SubagentTrace[]>,
): Map<string, SubagentTrace[]> {
  const grouped = new Map<string, SubagentTrace[]>();
  for (const trace of subagents) {
    const current = grouped.get(trace.turnId);
    if (current) current.push(trace);
    else grouped.set(trace.turnId, [trace]);
  }
  for (const [turnId, traces] of grouped) {
    const kept = previous.get(turnId);
    if (kept && kept.length === traces.length && kept.every((trace, index) => trace === traces[index])) {
      grouped.set(turnId, kept);
    }
  }
  return grouped;
}

export function usePublishedTurnSubagents(
  subagents: readonly SubagentTrace[] | undefined,
): ReadonlyMap<string, SubagentTrace[]> {
  const previous = useRef(new Map<string, SubagentTrace[]>());
  const byTurn = useMemo(() => {
    previous.current = groupByTurn(subagents ?? [], previous.current);
    return previous.current;
  }, [subagents]);
  const published = useRef<ReadonlyMap<string, readonly SubagentTrace[]>>(new Map());
  useLayoutEffect(() => {
    publishTurnSubagents(byTurn, published.current);
    published.current = byTurn;
  }, [byTurn]);
  useLayoutEffect(() => () => {
    publishTurnSubagents(new Map(), published.current);
    published.current = new Map();
  }, []);
  return byTurn;
}

export function useLatestTurnSubagents(
  turnId: string,
  fallback: readonly SubagentTrace[],
  enabled: boolean,
): readonly SubagentTrace[] {
  const read = useCallback(
    () => enabled ? latest.get(turnId) ?? null : null,
    [enabled, turnId],
  );
  return useSyncExternalStore(subscribe, read, read) ?? fallback;
}
