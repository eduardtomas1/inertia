import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Laptop, Trash2 } from "lucide-react";

import type { AgentTurn, SubagentTrace, WorkspaceRun } from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";
import { backgroundCommandRuns } from "../utils/backgroundTaskRuns";
import {
  subscribeBackgroundTaskReveal,
  takeBackgroundTaskReveal,
} from "../utils/backgroundTaskReveal";
import {
  backgroundTaskItems,
  backgroundTaskTitle,
  type BackgroundTaskItem,
  type BackgroundTaskItems,
} from "../utils/backgroundTasks";
import type { EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { canStopSubagentTrace } from "../utils/subagentDisclosure";
import { useBackgroundTaskFeed, type BackgroundTasksLoader } from "../hooks/useBackgroundTaskFeed";
import { removeLegacyDisclosurePreferences } from "../utils/legacyDisclosurePreferences";
import { AgentCard, CommandCard } from "./BackgroundTaskCards";
import "./WorkspaceSurfaces.css";
import "./BackgroundTasksSurface.css";

export interface BackgroundTasksSurfaceProps {
  runtimeStatus: EnvironmentSummarySnapshot["runtime"]["status"];
  subagents: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
  runs: readonly WorkspaceRun[];
  conversationId: string | null;
  loadTasks?: BackgroundTasksLoader;
  now?: number;
  canFollowUpSubagent?: (trace: SubagentTrace) => boolean;
  onFollowUpSubagent?: (trace: SubagentTrace) => void;
  onOpenSubagent?: (trace: SubagentTrace) => void;
  canStopSubagent?: (trace: SubagentTrace) => boolean;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
  onStopCommand?: (run: WorkspaceRun) => void;
  onDismissCommand?: (run: WorkspaceRun) => void;
}

const MAX_COMPACT_FINISHED = 20;
let legacyPreferencesRemoved = false;

function traceById(traces: readonly SubagentTrace[], id: string): SubagentTrace | undefined {
  return traces.find((trace) => trace.id === id);
}

interface FocusRecord {
  row: string;
  key: string | null;
}

function useFocusContinuity(): {
  regionRef: React.RefObject<HTMLElement | null>;
  onFocusCapture: React.FocusEventHandler<HTMLElement>;
  onBlurCapture: React.FocusEventHandler<HTMLElement>;
} {
  const regionRef = useRef<HTMLElement>(null);
  const record = useRef<FocusRecord | null>(null);
  useLayoutEffect(() => {
    const current = record.current;
    const region = regionRef.current;
    const active = document.activeElement;
    if (!current || !region || (active && active !== document.body)) return;
    const row = [...region.querySelectorAll<HTMLElement>("[data-focus-row]")]
      .find((element) => element.dataset.focusRow === current.row);
    const control = (current.key
      ? row?.querySelector<HTMLElement>(`[data-focus-key="${current.key}"]:not(:disabled)`)
      : null)
      ?? row?.querySelector<HTMLElement>('[data-focus-key="transcript"], [data-focus-finished]')
      ?? row?.querySelector<HTMLElement>("button:not(:disabled)")
      ?? region.querySelector<HTMLElement>("[data-focus-finished]")
      ?? region.querySelector<HTMLElement>("button:not(:disabled)");
    if (control) control.focus();
    else record.current = null;
  });
  return {
    regionRef,
    onFocusCapture: (event) => {
      const target = event.target as HTMLElement;
      const row = target.closest<HTMLElement>("[data-focus-row]");
      record.current = row?.dataset.focusRow
        ? { row: row.dataset.focusRow, key: target.dataset.focusKey ?? null }
        : null;
    },
    onBlurCapture: (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node) {
        if (!event.currentTarget.contains(next)) record.current = null;
        return;
      }
      const target = event.target as HTMLElement;
      queueMicrotask(() => {
        if (target.isConnected) record.current = null;
      });
    },
  };
}

const MAX_REVEAL_PAGES = 10;

function useTurnReveal(
  conversationId: string | null,
  regionRef: React.RefObject<HTMLElement | null>,
  items: BackgroundTaskItems,
  turns: readonly AgentTurn[],
  finishedOpen: boolean,
  showAllFinished: boolean,
  openFinished: (showAll: boolean) => void,
  more: { hasMore: boolean; loadMore: () => Promise<boolean> } | null,
): void {
  const [turnId, setTurnId] = useState<string | null>(null);
  const paging = useRef({ pages: 0, pending: false });
  const [paged, setPaged] = useState(0);
  useLayoutEffect(() => {
    if (!conversationId) return;
    const take = (): void => {
      const requested = takeBackgroundTaskReveal(conversationId);
      if (!requested) return;
      paging.current = { pages: 0, pending: false };
      setTurnId(requested);
    };
    take();
    return subscribeBackgroundTaskReveal(take);
  }, [conversationId]);
  useLayoutEffect(() => {
    if (!turnId || paging.current.pending) return;
    const ofTurn = (item: BackgroundTaskItem) => item.type === "agent" && item.trace.turnId === turnId;
    const index = items.finished.findIndex(ofTurn);
    const requestedAt = turns.find(({ id }) => id === turnId)?.requestedAt;
    const oldest = items.finished.at(-1)?.startedAt;
    if (
      index < 0
      && !items.active.some(ofTurn)
      && more?.hasMore
      && requestedAt !== undefined
      && (oldest === undefined || oldest >= requestedAt)
      && paging.current.pages < MAX_REVEAL_PAGES
    ) {
      paging.current = { pages: paging.current.pages + 1, pending: true };
      void more.loadMore().then((loaded) => {
        paging.current = { ...paging.current, pending: false };
        if (!loaded) setTurnId(null);
        else setPaged((count) => count + 1);
      });
      return;
    }
    const showAll = index >= MAX_COMPACT_FINISHED;
    if (index >= 0 && (!finishedOpen || (showAll && !showAllFinished))) {
      openFinished(showAll);
      return;
    }
    const rows = regionRef.current?.querySelectorAll<HTMLElement>("[data-reveal-turn]") ?? [];
    [...rows].find((row) => row.dataset.revealTurn === turnId)?.scrollIntoView({ block: "nearest" });
    setTurnId(null);
  }, [finishedOpen, items, more, openFinished, paged, regionRef, showAllFinished, turnId, turns]);
}

function toggled(current: ReadonlySet<string>, id: string, on?: boolean): ReadonlySet<string> {
  const next = new Set(current);
  if (on ?? !next.has(id)) next.add(id);
  else next.delete(id);
  return next;
}

export function BackgroundTasksSurface({
  runtimeStatus,
  subagents,
  turns,
  runs,
  conversationId,
  loadTasks,
  now,
  canFollowUpSubagent,
  onFollowUpSubagent,
  onOpenSubagent,
  canStopSubagent,
  onStopSubagent,
  onStopCommand,
  onDismissCommand,
}: BackgroundTasksSurfaceProps): React.JSX.Element {
  const surfaceId = useId();
  const focus = useFocusContinuity();
  useEffect(() => {
    if (legacyPreferencesRemoved) return;
    legacyPreferencesRemoved = true;
    removeLegacyDisclosurePreferences(() => window.localStorage);
  }, []);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [finishedOpen, setFinishedOpen] = useState(false);
  const [showAllFinished, setShowAllFinished] = useState(false);
  const feed = useBackgroundTaskFeed(conversationId, loadTasks, subagents, runs, turns);
  const commands = useMemo(
    () => feed?.runs ?? backgroundCommandRuns(runs, conversationId, turns),
    [conversationId, feed, runs, turns],
  );
  const traces = feed?.subagents ?? subagents;
  const items = useMemo(() => backgroundTaskItems(traces, commands), [commands, traces]);
  const openFinished = useCallback((showAll: boolean) => {
    setFinishedOpen(true);
    if (showAll) setShowAllFinished(true);
  }, []);
  useTurnReveal(conversationId, focus.regionRef, items, turns, finishedOpen, showAllFinished, openFinished, feed);
  const latest = useRef({ subagents: traces, stopping, onOpenSubagent, onFollowUpSubagent, onStopSubagent });
  useLayoutEffect(() => {
    latest.current = { subagents: traces, stopping, onOpenSubagent, onFollowUpSubagent, onStopSubagent };
  });
  const toggleDetails = useCallback((id: string) => setExpanded((current) => toggled(current, id)), []);
  const open = useCallback((id: string) => {
    const trace = traceById(latest.current.subagents, id);
    if (trace) latest.current.onOpenSubagent?.(trace);
  }, []);
  const followUp = useCallback((id: string) => {
    const trace = traceById(latest.current.subagents, id);
    if (trace) latest.current.onFollowUpSubagent?.(trace);
  }, []);
  const stop = useCallback((id: string) => {
    const trace = traceById(latest.current.subagents, id);
    const onStop = latest.current.onStopSubagent;
    if (!trace || !onStop || latest.current.stopping.has(id)) return;
    setStopping((current) => toggled(current, id, true));
    void onStop(trace).catch(() => undefined).finally(() => {
      setStopping((current) => toggled(current, id, false));
    });
  }, []);
  const renderItem = (item: BackgroundTaskItem): React.JSX.Element => {
    if (item.type === "command") {
      return <CommandCard key={item.key} run={item.run} now={now} onStop={onStopCommand} />;
    }
    const { trace } = item;
    const parent = trace.parentTraceId ? traceById(traces, trace.parentTraceId) : undefined;
    return (
      <AgentCard
        key={item.key}
        trace={trace}
        turns={turns}
        parentTitle={parent ? backgroundTaskTitle(parent) : null}
        transcriptId={`${surfaceId}-${trace.id}-transcript`}
        expanded={expanded.has(trace.id)}
        stopping={stopping.has(trace.id)}
        now={now}
        canOpen={Boolean(onOpenSubagent && turns.some(({ id }) => id === trace.turnId))}
        canFollowUp={Boolean(onFollowUpSubagent && canFollowUpSubagent?.(trace))}
        canStop={Boolean(
          onStopSubagent
          && canStopSubagentTrace(trace, turns)
          && (canStopSubagent?.(trace) ?? true),
        )}
        onToggle={toggleDetails}
        onOpen={open}
        onFollowUp={followUp}
        onStop={stop}
      />
    );
  };
  const dismissible = onDismissCommand
    ? items.finished.flatMap((item) =>
      item.type === "command" && workspaceRunAttentionView(item.run).canDismiss ? [item.run] : [])
    : [];
  const finishedCount = Math.max(feed?.finishedCount ?? 0, items.finished.length);
  const failedCount = Math.max(feed?.failedCount ?? 0, items.failed);
  const visibleFinished = showAllFinished
    ? items.finished
    : items.finished.slice(0, MAX_COMPACT_FINISHED);
  const hiddenFinished = finishedCount - visibleFinished.length;
  const showMoreFinished = (): void => {
    if (hiddenFinished === 0) {
      setShowAllFinished(false);
      return;
    }
    setShowAllFinished(true);
    if (showAllFinished || items.finished.length <= MAX_COMPACT_FINISHED) void feed?.loadMore();
  };
  const attention = runtimeStatus === "online"
    ? null
    : runtimeStatus === "connecting"
      ? { title: "Connecting to workspace", detail: "Live task details may be incomplete." }
      : { title: "Workspace runtime unavailable", detail: "Live task details may be out of date." };
  return (
    <section
      ref={focus.regionRef}
      className="workspace-surface background-tasks-surface"
      aria-label="Background tasks"
      onFocusCapture={focus.onFocusCapture}
      onBlurCapture={focus.onBlurCapture}
    >
      <div className="workspace-surface-scroll">
        {attention && (
          <div
            className={`workspace-surface-attention is-${runtimeStatus}`}
            role="status"
            aria-live="polite"
          >
            <Laptop size={14} aria-hidden="true" />
            <span><strong>{attention.title}</strong><small>{attention.detail}</small></span>
          </div>
        )}
        {items.active.length === 0 && finishedCount === 0 && (
          <p className="background-tasks-label">No background tasks.</p>
        )}
        {items.active.length > 0 && (
          <div className="background-tasks-group">
            <p id={`${surfaceId}-running`} className="background-tasks-label">Running</p>
            <ol className="background-tasks-list" aria-labelledby={`${surfaceId}-running`}>
              {items.active.map(renderItem)}
            </ol>
          </div>
        )}
        {finishedCount > 0 && (
          <div className="background-tasks-group" data-focus-row="finished">
            <div className="background-tasks-finished">
              <button
                type="button"
                className="background-tasks-finished-toggle"
                data-focus-finished
                aria-expanded={finishedOpen}
                aria-controls={finishedOpen ? `${surfaceId}-finished` : undefined}
                onClick={() => setFinishedOpen((current) => !current)}
              >
                Finished <span className="background-task-value">{finishedCount}</span>
                {failedCount > 0 && (
                  <>
                    {" · "}
                    <span className="background-task-danger">{failedCount} failed</span>
                  </>
                )}
                <ChevronRight size={13} aria-hidden="true" />
              </button>
              {dismissible.length > 0 && (
                <button
                  type="button"
                  className="background-task-stop background-tasks-dismiss"
                  aria-label="Dismiss finished commands"
                  onClick={() => {
                    for (const run of dismissible) onDismissCommand?.(run);
                    feed?.dismissed(dismissible.map(({ id }) => id));
                  }}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              )}
            </div>
            {finishedOpen && (
              <ol id={`${surfaceId}-finished`} className="background-tasks-list" aria-label="Finished">
                {visibleFinished.map(renderItem)}
              </ol>
            )}
            {finishedOpen && (hiddenFinished > 0 || showAllFinished) && (
              <button
                type="button"
                className="background-task-link"
                aria-expanded={showAllFinished}
                onClick={showMoreFinished}
              >
                {hiddenFinished === 0
                  ? "Show fewer finished tasks"
                  : `Show ${hiddenFinished} more finished ${hiddenFinished === 1 ? "task" : "tasks"}`}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
