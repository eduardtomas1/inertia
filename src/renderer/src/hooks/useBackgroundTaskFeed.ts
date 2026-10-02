import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentTurn, SubagentTrace, WorkspaceRun } from "@shared/contracts";
import type { BackgroundTaskCursor, BackgroundTasksResult } from "@shared/background-tasks";
import { workspaceRunAttentionView } from "../../../shared/attention";
import { backgroundCommandIsLive, backgroundCommandRuns } from "../utils/backgroundTaskRuns";

export type BackgroundTasksLoader = (before: BackgroundTaskCursor | null) => Promise<BackgroundTasksResult>;

export interface BackgroundTaskFeed {
  subagents: SubagentTrace[];
  runs: WorkspaceRun[];
  finishedCount: number;
  failedCount: number;
  hasMore: boolean;
  loadMore: () => void;
}

interface Feed {
  conversationId: string;
  traces: ReadonlyMap<string, SubagentTrace>;
  runs: ReadonlyMap<string, WorkspaceRun>;
  finishedCount: number;
  failedCount: number;
  next: BackgroundTaskCursor | null;
  deep: boolean;
}

const REFRESH_INTERVAL_MS = 1_000;
const FAILED_TASK_STATUSES: ReadonlySet<string> = new Set(["failed", "interrupted", "lost"]);

function counted(item: SubagentTrace | WorkspaceRun | undefined): { finished: number; failed: number } {
  if (!item) return { finished: 0, failed: 0 };
  if ("turnId" in item) {
    return item.isLive ? { finished: 0, failed: 0 } : { finished: 1, failed: FAILED_TASK_STATUSES.has(item.status) ? 1 : 0 };
  }
  if (backgroundCommandIsLive(item) || workspaceRunAttentionView(item).bucket === "hidden") return { finished: 0, failed: 0 };
  return { finished: 1, failed: item.status === "failed" ? 1 : 0 };
}

function merged(previous: Feed | null, result: BackgroundTasksResult, head: boolean): Feed {
  const kept = previous?.conversationId === result.conversationId ? previous : null;
  const traces = new Map<string, SubagentTrace>();
  const runs = new Map<string, WorkspaceRun>();
  const cursor = result.next;
  const beyond = (startedAt: string, key: string): boolean => !head || (cursor !== null
    && (startedAt < cursor.startedAt || (startedAt === cursor.startedAt && key < cursor.key)));
  for (const trace of kept?.traces.values() ?? []) {
    if (!trace.isLive && beyond(trace.createdAt, `agent:${trace.id}`)) traces.set(trace.id, trace);
  }
  for (const run of kept?.runs.values() ?? []) {
    if (!backgroundCommandIsLive(run) && beyond(run.startedAt, `command:${run.id}`)) runs.set(run.id, run);
  }
  for (const trace of result.subagents) traces.set(trace.id, trace);
  for (const run of result.runs) runs.set(run.id, run);
  const deep = Boolean(kept?.deep) || !head;
  return {
    conversationId: result.conversationId,
    traces,
    runs,
    finishedCount: result.finishedCount,
    failedCount: result.failedCount,
    next: head && kept?.deep ? kept.next : result.next,
    deep,
  };
}

function classification(
  subagents: readonly SubagentTrace[],
  runs: readonly WorkspaceRun[],
  conversationId: string | null,
): string {
  return [
    ...subagents.filter((trace) => trace.conversationId === conversationId)
      .map(({ id, isLive, status }) => `agent:${id}:${isLive ? "live" : status}`),
    ...runs.filter((run) => run.conversationId === conversationId)
      .map(({ id, status, attentionState }) => `command:${id}:${status}:${attentionState === "dismissed"}`),
  ].sort().join("\n");
}

export function useBackgroundTaskFeed(
  conversationId: string | null,
  loader: BackgroundTasksLoader | undefined,
  subagents: readonly SubagentTrace[],
  runs: readonly WorkspaceRun[],
  turns: readonly AgentTurn[],
): BackgroundTaskFeed | null {
  const [feed, setFeed] = useState<Feed | null>(null);
  const loaderRef = useRef(loader);
  const generation = useRef(0);
  const head = useRef({ inFlight: false, again: false, at: Number.NEGATIVE_INFINITY, timer: 0 });
  const paging = useRef(false);
  const available = Boolean(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  const fetchHead = useCallback((): void => {
    const state = head.current;
    const load = loaderRef.current;
    if (!conversationId || !load) return;
    if (state.inFlight) {
      state.again = true;
      return;
    }
    const owner = generation.current;
    state.inFlight = true;
    state.at = Date.now();
    const settle = (): void => {
      if (generation.current !== owner) return;
      state.inFlight = false;
      if (state.again) {
        state.again = false;
        state.timer = window.setTimeout(() => {
          state.timer = 0;
          fetchHead();
        }, REFRESH_INTERVAL_MS);
      }
    };
    void load(null).then((result) => {
      if (generation.current !== owner || result.conversationId !== conversationId) return;
      setFeed((previous) => merged(previous, result, true));
      settle();
    }, settle);
  }, [conversationId]);
  useEffect(() => {
    generation.current += 1;
    const state = head.current;
    window.clearTimeout(state.timer);
    head.current = { inFlight: false, again: false, at: Number.NEGATIVE_INFINITY, timer: 0 };
    paging.current = false;
    setFeed(null);
    if (!available) return;
    fetchHead();
    return () => {
      generation.current += 1;
      window.clearTimeout(head.current.timer);
    };
  }, [available, conversationId, fetchHead]);
  const signature = classification(subagents, runs, conversationId);
  const lastSignature = useRef({ conversationId, signature });
  useEffect(() => {
    const previous = lastSignature.current;
    if (previous.signature === signature) return;
    lastSignature.current = { conversationId, signature };
    if (previous.conversationId !== conversationId) return;
    const state = head.current;
    if (!available || state.timer) return;
    const wait = Math.max(0, state.at + REFRESH_INTERVAL_MS - Date.now());
    state.timer = window.setTimeout(() => {
      state.timer = 0;
      fetchHead();
    }, wait);
  }, [available, conversationId, fetchHead, signature]);
  const next = feed?.next ?? null;
  const loadMore = useCallback((): void => {
    const load = loaderRef.current;
    if (!next || !load || paging.current) return;
    const owner = generation.current;
    paging.current = true;
    void load(next).then((result) => {
      if (generation.current !== owner || result.conversationId !== conversationId) return;
      paging.current = false;
      setFeed((previous) => merged(previous, result, false));
    }, () => {
      if (generation.current === owner) paging.current = false;
    });
  }, [conversationId, next]);
  return useMemo(() => {
    if (!feed || feed.conversationId !== conversationId) return null;
    let finishedCount = feed.finishedCount;
    let failedCount = feed.failedCount;
    const replace = <T extends SubagentTrace | WorkspaceRun>(known: T | undefined, next: T): void => {
      if (!known) return;
      const before = counted(known);
      const after = counted(next);
      finishedCount += after.finished - before.finished;
      failedCount += after.failed - before.failed;
    };
    const traces = new Map(feed.traces);
    for (const trace of subagents) {
      if (trace.conversationId !== conversationId) continue;
      const known = traces.get(trace.id);
      if (known && trace.sequence < known.sequence) continue;
      replace(feed.traces.get(trace.id), trace);
      traces.set(trace.id, trace);
    }
    const commands = new Map(feed.runs);
    const added = new Set(backgroundCommandRuns(runs, conversationId, turns).map(({ id }) => id));
    for (const run of runs) {
      if (run.conversationId !== conversationId || (!commands.has(run.id) && !added.has(run.id))) continue;
      replace(feed.runs.get(run.id), run);
      commands.set(run.id, run);
    }
    return {
      subagents: [...traces.values()],
      runs: [...commands.values()].filter((run) => workspaceRunAttentionView(run).bucket !== "hidden"),
      finishedCount: Math.max(0, finishedCount),
      failedCount: Math.max(0, Math.min(failedCount, finishedCount)),
      hasMore: feed.next !== null,
      loadMore,
    };
  }, [conversationId, feed, loadMore, runs, subagents, turns]);
}
