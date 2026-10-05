import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentTurn, SubagentTrace, WorkspaceRun } from "@shared/contracts";
import type { BackgroundTaskCursor, BackgroundTasksResult } from "@shared/background-tasks";
import { workspaceRunAttentionView } from "../../../shared/attention";
import { backgroundCommandIsLive, backgroundCommandRuns } from "../utils/backgroundTaskRuns";
import { useDocumentVisibility } from "./useDocumentPresence";

export type BackgroundTasksLoader = (before: BackgroundTaskCursor | null) => Promise<BackgroundTasksResult>;

export interface BackgroundTaskFeed {
  subagents: SubagentTrace[];
  runs: WorkspaceRun[];
  finishedCount: number;
  failedCount: number;
  hasMore: boolean;
  loadMore: () => Promise<boolean>;
  dismissed: (runIds: readonly string[]) => void;
}

interface Feed {
  conversationId: string;
  traces: ReadonlyMap<string, SubagentTrace>;
  runs: ReadonlyMap<string, WorkspaceRun>;
  finishedCount: number;
  failedCount: number;
  next: BackgroundTaskCursor | null;
  pages: number;
  restore: number;
}

interface HeadState {
  inFlight: boolean;
  again: boolean;
  at: number;
  timer: number;
}

const REFRESH_INTERVAL_MS = 1_000;
const OFF_SNAPSHOT_REFRESH_MS = 10_000;
const FAILED_TASK_STATUSES: ReadonlySet<string> = new Set(["failed", "interrupted", "lost"]);

function counted(item: SubagentTrace | WorkspaceRun): { finished: number; failed: number } {
  if ("turnId" in item) {
    return item.isLive ? { finished: 0, failed: 0 } : { finished: 1, failed: FAILED_TASK_STATUSES.has(item.status) ? 1 : 0 };
  }
  if (backgroundCommandIsLive(item) || workspaceRunAttentionView(item).bucket === "hidden") return { finished: 0, failed: 0 };
  return { finished: 1, failed: item.status === "failed" ? 1 : 0 };
}

function olderThan(cursor: BackgroundTaskCursor | null, startedAt: string, key: string): boolean {
  return cursor !== null && (startedAt < cursor.startedAt || (startedAt === cursor.startedAt && key < cursor.key));
}

function finishedTotal(feed: Pick<Feed, "traces" | "runs">): number {
  let total = 0;
  for (const trace of feed.traces.values()) total += counted(trace).finished;
  for (const run of feed.runs.values()) total += counted(run).finished;
  return total;
}

function merged(previous: Feed | null, result: BackgroundTasksResult, head: boolean): Feed {
  const kept = previous?.conversationId === result.conversationId ? previous : null;
  const pages = (kept?.pages ?? 0) + (head ? 0 : 1);
  const loadedTo = head && kept && kept.pages > 0 ? kept.next : result.next;
  const traces = new Map<string, SubagentTrace>();
  const runs = new Map<string, WorkspaceRun>();
  for (const trace of kept?.traces.values() ?? []) {
    if (!head || (!trace.isLive && olderThan(result.next, trace.createdAt, `agent:${trace.id}`))) traces.set(trace.id, trace);
  }
  for (const run of kept?.runs.values() ?? []) {
    if (!head || (!backgroundCommandIsLive(run) && olderThan(result.next, run.startedAt, `command:${run.id}`))) runs.set(run.id, run);
  }
  for (const trace of result.subagents) {
    if (trace.isLive || !olderThan(loadedTo, trace.createdAt, `agent:${trace.id}`)) traces.set(trace.id, trace);
  }
  for (const run of result.runs) {
    if (backgroundCommandIsLive(run) || !olderThan(loadedTo, run.startedAt, `command:${run.id}`)) runs.set(run.id, run);
  }
  const feed = {
    conversationId: result.conversationId,
    traces,
    runs,
    finishedCount: result.finishedCount,
    failedCount: result.failedCount,
    next: loadedTo,
    pages,
    restore: kept?.restore ?? 0,
  };
  if (head && pages > 0 && loadedTo === null && finishedTotal(feed) !== result.finishedCount) {
    return { ...merged(null, result, true), restore: pages };
  }
  return feed;
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
  const [dropped, setDropped] = useState<ReadonlyMap<string, number>>(() => new Map());
  const visible = useDocumentVisibility();
  const loaderRef = useRef(loader);
  const generation = useRef(0);
  const head = useRef<HeadState>({ inFlight: false, again: false, at: Number.NEGATIVE_INFINITY, timer: 0 });
  const paging = useRef<Promise<boolean> | null>(null);
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
    const startedAt = Date.now();
    state.inFlight = true;
    state.at = startedAt;
    const settle = (): void => {
      if (generation.current !== owner || head.current !== state) return;
      state.inFlight = false;
      if (!state.again) return;
      state.again = false;
      if (state.timer) return;
      state.timer = window.setTimeout(() => {
        state.timer = 0;
        if (head.current === state) fetchHead();
      }, REFRESH_INTERVAL_MS);
    };
    void load(null).then((result) => {
      if (generation.current === owner && result.conversationId === conversationId) {
        setFeed((previous) => merged(previous, result, true));
        setDropped((current) => current.size === 0 ? current
          : new Map([...current].filter(([, at]) => at >= startedAt)));
      }
      settle();
    }, settle);
  }, [conversationId]);
  const scheduleHead = useCallback((): void => {
    const state = head.current;
    if (state.timer) return;
    const wait = Math.max(0, state.at + REFRESH_INTERVAL_MS - Date.now());
    state.timer = window.setTimeout(() => {
      state.timer = 0;
      if (head.current === state) fetchHead();
    }, wait);
  }, [fetchHead]);
  useEffect(() => {
    generation.current += 1;
    window.clearTimeout(head.current.timer);
    head.current = { inFlight: false, again: false, at: Number.NEGATIVE_INFINITY, timer: 0 };
    paging.current = null;
    setFeed(null);
    setDropped(new Map());
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
    if (previous.conversationId !== conversationId || !available) return;
    scheduleHead();
  }, [available, conversationId, scheduleHead, signature]);
  const offSnapshot = useMemo(() => {
    if (!feed || feed.conversationId !== conversationId) return false;
    const known = new Set(runs.map(({ id }) => id));
    return [...feed.runs.values()].some((run) => backgroundCommandIsLive(run) && !known.has(run.id));
  }, [conversationId, feed, runs]);
  const watchOffSnapshot = offSnapshot && visible && available;
  useEffect(() => {
    if (!watchOffSnapshot) return;
    const timer = window.setInterval(scheduleHead, OFF_SNAPSHOT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [scheduleHead, watchOffSnapshot]);
  const next = feed?.next ?? null;
  const loadMore = useCallback((): Promise<boolean> => {
    const load = loaderRef.current;
    if (!next || !load) return Promise.resolve(false);
    if (paging.current) return paging.current;
    const owner = generation.current;
    const request = load(next).then((result) => {
      if (generation.current !== owner || result.conversationId !== conversationId) return false;
      setFeed((previous) => merged(previous, result, false));
      return true;
    }, () => false).finally(() => {
      if (paging.current === request) paging.current = null;
    });
    paging.current = request;
    return request;
  }, [conversationId, next]);
  const restoring = feed !== null && feed.restore > feed.pages && feed.next !== null;
  useEffect(() => {
    if (!restoring) return;
    void loadMore().then((loaded) => {
      if (!loaded) setFeed((current) => current && { ...current, restore: 0 });
    });
  }, [loadMore, restoring]);
  const dismissed = useCallback((runIds: readonly string[]): void => {
    if (runIds.length === 0) return;
    const at = Date.now();
    setDropped((current) => new Map([...current, ...runIds.map((id) => [id, at] as const)]));
    scheduleHead();
  }, [scheduleHead]);
  return useMemo(() => {
    if (!feed || feed.conversationId !== conversationId) return null;
    let finishedCount = feed.finishedCount;
    let failedCount = feed.failedCount;
    const adjust = (known: SubagentTrace | WorkspaceRun, next: SubagentTrace | WorkspaceRun | null): void => {
      const before = counted(known);
      const after = next ? counted(next) : { finished: 0, failed: 0 };
      finishedCount += after.finished - before.finished;
      failedCount += after.failed - before.failed;
    };
    const traces = new Map(feed.traces);
    for (const trace of subagents) {
      if (trace.conversationId !== conversationId) continue;
      const known = traces.get(trace.id);
      if (known && trace.sequence < known.sequence) continue;
      const fetched = feed.traces.get(trace.id);
      if (fetched) adjust(fetched, trace);
      traces.set(trace.id, trace);
    }
    const commands = new Map(feed.runs);
    const added = new Set(backgroundCommandRuns(runs, conversationId, turns).map(({ id }) => id));
    for (const run of runs) {
      if (run.conversationId !== conversationId || (!commands.has(run.id) && !added.has(run.id))) continue;
      const fetched = feed.runs.get(run.id);
      if (fetched) adjust(fetched, run);
      commands.set(run.id, run);
    }
    for (const id of dropped.keys()) {
      const run = commands.get(id);
      if (!run) continue;
      if (feed.runs.has(id)) adjust(feed.runs.get(id)!, null);
      commands.delete(id);
    }
    return {
      subagents: [...traces.values()],
      runs: [...commands.values()].filter((run) => workspaceRunAttentionView(run).bucket !== "hidden"),
      finishedCount: Math.max(0, finishedCount),
      failedCount: Math.max(0, Math.min(failedCount, finishedCount)),
      hasMore: feed.next !== null,
      loadMore,
      dismissed,
    };
  }, [conversationId, dismissed, dropped, feed, loadMore, runs, subagents, turns]);
}
