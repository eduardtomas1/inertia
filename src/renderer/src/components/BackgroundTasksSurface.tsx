import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  GitBranch,
  Globe2,
  Laptop,
  ListTree,
  MessageSquareText,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import type { AgentTurn, SubagentTrace, WorkspaceRun } from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";
import { useDocumentVisibility } from "../hooks/useDocumentPresence";
import {
  BACKGROUND_TASK_TOKENS_NOTE,
  backgroundTaskEmptyNote,
  backgroundTaskGroups,
  backgroundTaskSummaryLabel,
  backgroundTaskTokenTotalLabel,
} from "../utils/backgroundTasks";
import type { EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { formatElapsed } from "../utils/responseTimeline";
import { compactSubagentDisclosureRows } from "../utils/subagentCompactRows";
import {
  subagentDisclosureRows,
  type SubagentDisclosureRow,
} from "../utils/subagentDisclosure";
import {
  workspaceRunIsLive,
  workspaceRunStatusLabel,
} from "../utils/workspaceRuns";
import { BackgroundTaskRow } from "./BackgroundTaskRow";
import { subscribeLiveElapsed } from "./SubagentElapsed";
import "./BeautifulUiMotion.css";
import "./WorkspaceSurfaces.css";
import "./BackgroundTasksSurface.css";

export interface BackgroundTasksSurfaceProps {
  runtimeStatus: EnvironmentSummarySnapshot["runtime"]["status"];
  subagents: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
  commands: readonly WorkspaceRun[];
  harnessId: string | null;
  now?: number;
  canFollowUpSubagent?: (trace: SubagentTrace) => boolean;
  onFollowUpSubagent?: (trace: SubagentTrace) => void;
  onOpenSubagent?: (trace: SubagentTrace) => void;
  canStopSubagent?: (trace: SubagentTrace) => boolean;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
  onStopCommand?: (run: WorkspaceRun) => void;
  onDismissCommand?: (run: WorkspaceRun) => void;
}

const MAX_COMPACT_FINISHED_TASKS = 5;

const commandIcons: Record<WorkspaceRun["kind"], React.JSX.Element> = {
  agent: <MessageSquareText size={12} aria-hidden="true" />,
  check: <SquareTerminal size={12} aria-hidden="true" />,
  service: <Globe2 size={12} aria-hidden="true" />,
  "source-control": <GitBranch size={12} aria-hidden="true" />,
};

function commandElapsedMs(run: WorkspaceRun, now: number): number | null {
  const startedAt = Date.parse(run.startedAt);
  const end = workspaceRunIsLive(run)
    ? now
    : run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(end)) return null;
  return Math.max(0, end - startedAt);
}

function CommandElapsed({
  run,
  now,
}: {
  run: WorkspaceRun;
  now?: number;
}): React.JSX.Element | null {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = workspaceRunIsLive(run);
  const documentVisible = useDocumentVisibility();
  useEffect(() => {
    if (!live || now !== undefined || !documentVisible) return;
    return subscribeLiveElapsed(() => {
      const elapsed = commandElapsedMs(run, Date.now());
      if (textRef.current && elapsed !== null) {
        textRef.current.textContent = formatElapsed(elapsed);
      }
    });
  }, [documentVisible, live, now, run]);
  const elapsed = commandElapsedMs(run, now ?? Date.now());
  if (elapsed === null) return null;
  return <span ref={textRef} className="subagent-elapsed">{formatElapsed(elapsed)}</span>;
}

function CommandRow({
  run,
  now,
  onStop,
  onDismiss,
}: {
  run: WorkspaceRun;
  now?: number;
  onStop?: (run: WorkspaceRun) => void;
  onDismiss?: (run: WorkspaceRun) => void;
}): React.JSX.Element {
  const status = workspaceRunStatusLabel(run.status);
  const canDismiss = Boolean(onDismiss && workspaceRunAttentionView(run).canDismiss);
  const canStop = Boolean(onStop && run.canStop && workspaceRunIsLive(run));
  return (
    <li
      className="background-task-row is-command"
      data-run-id={run.id}
      data-status={run.status}
      data-live={workspaceRunIsLive(run)}
      aria-label={`${run.label}, ${status}`}
    >
      <span className="background-command-mark" data-status={run.status} aria-hidden="true">
        {commandIcons[run.kind]}
      </span>
      <div className="background-task-main">
        <div className="background-task-heading">
          <strong title={run.label}>{run.label}</strong>
          <span className="background-task-status">{status}</span>
        </div>
        {run.detail && <p className="background-task-doing" title={run.detail}>{run.detail}</p>}
        {(canStop || canDismiss) && (
          <div className="background-task-actions">
            {canStop && (
              <button
                type="button"
                className="background-task-stop"
                aria-label={`Stop ${run.label}`}
                onClick={() => onStop?.(run)}
              >
                <Square size={9} fill="currentColor" aria-hidden="true" />
                Stop
              </button>
            )}
            {canDismiss && (
              <button
                type="button"
                aria-label={`Dismiss ${run.label}`}
                onClick={() => onDismiss?.(run)}
              >
                <Trash2 size={11} aria-hidden="true" />
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
      <div className="background-task-metrics">
        <CommandElapsed run={run} now={now} />
      </div>
    </li>
  );
}

function AgentGroup({
  label,
  rows,
  listId,
  labelId,
  indexOffset,
  render,
}: {
  label: string;
  rows: readonly (SubagentDisclosureRow & { omittedAncestors: number })[];
  listId: string;
  labelId: string;
  indexOffset: number;
  render: (
    row: SubagentDisclosureRow & { omittedAncestors: number },
    index: number,
  ) => React.JSX.Element;
}): React.JSX.Element {
  return (
    <div className="background-tasks-group">
      <span id={labelId} className="background-tasks-group-label">{label}</span>
      <ol id={listId} className="background-tasks-list" aria-labelledby={labelId}>
        {rows.map((row, index) => render(row, indexOffset + index))}
      </ol>
    </div>
  );
}

function BackgroundTaskAgents({
  subagents,
  turns,
  now,
  idPrefix,
  canFollowUpSubagent,
  onFollowUpSubagent,
  onOpenSubagent,
  canStopSubagent,
  onStopSubagent,
}: Pick<
  BackgroundTasksSurfaceProps,
  | "subagents"
  | "turns"
  | "now"
  | "canFollowUpSubagent"
  | "onFollowUpSubagent"
  | "onOpenSubagent"
  | "canStopSubagent"
  | "onStopSubagent"
> & {
  idPrefix: string;
}): React.JSX.Element {
  const [showAllFinished, setShowAllFinished] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const groups = useMemo(
    () => backgroundTaskGroups(subagentDisclosureRows(subagents, turns)),
    [subagents, turns],
  );
  const compactFinished = useMemo(
    () => compactSubagentDisclosureRows(groups.finished, MAX_COMPACT_FINISHED_TASKS),
    [groups.finished],
  );
  const active = groups.active.map((row) => ({ ...row, omittedAncestors: 0 }));
  const finished = showAllFinished
    ? groups.finished.map((row) => ({ ...row, omittedAncestors: 0 }))
    : compactFinished;
  const hiddenFinished = groups.finished.length - compactFinished.length;
  const toggle = (
    update: (next: Set<string>) => void,
    set: typeof setExpanded,
  ): void => set((current) => {
    const next = new Set(current);
    update(next);
    return next;
  });
  const renderRow = (
    { trace, depth, canStop, omittedAncestors }: SubagentDisclosureRow & { omittedAncestors: number },
    index: number,
  ): React.JSX.Element => (
    <BackgroundTaskRow
      key={trace.id}
      trace={trace}
      traces={subagents}
      turns={turns}
      depth={depth}
      omittedAncestors={omittedAncestors}
      index={index}
      detailsId={`${idPrefix}-${trace.id}-details`}
      expanded={expanded.has(trace.id)}
      stopping={stopping.has(trace.id)}
      now={now}
      canOpen={Boolean(onOpenSubagent && turns.some(({ id }) => id === trace.turnId))}
      canFollowUp={Boolean(onFollowUpSubagent && canFollowUpSubagent?.(trace))}
      canStop={Boolean(onStopSubagent && canStop && (canStopSubagent?.(trace) ?? true))}
      onToggleDetails={() => toggle((next) => {
        if (!next.delete(trace.id)) next.add(trace.id);
      }, setExpanded)}
      onOpen={() => onOpenSubagent?.(trace)}
      onFollowUp={() => onFollowUpSubagent?.(trace)}
      onStop={() => {
        if (!onStopSubagent || stopping.has(trace.id)) return;
        toggle((next) => next.add(trace.id), setStopping);
        void onStopSubagent(trace).catch(() => undefined).finally(() => {
          toggle((next) => next.delete(trace.id), setStopping);
        });
      }}
    />
  );
  return (
    <>
      {active.length > 0 && (
        <AgentGroup
          label="Active"
          rows={active}
          listId={`${idPrefix}-active`}
          labelId={`${idPrefix}-active-label`}
          indexOffset={0}
          render={renderRow}
        />
      )}
      {finished.length > 0 && (
        <AgentGroup
          label="Finished"
          rows={finished}
          listId={`${idPrefix}-finished`}
          labelId={`${idPrefix}-finished-label`}
          indexOffset={active.length}
          render={renderRow}
        />
      )}
      {hiddenFinished > 0 && (
        <button
          type="button"
          className="background-tasks-toggle"
          aria-controls={`${idPrefix}-finished`}
          aria-expanded={showAllFinished}
          onClick={() => setShowAllFinished((current) => !current)}
        >
          {showAllFinished
            ? "Show fewer finished tasks"
            : `Show ${hiddenFinished} more finished ${hiddenFinished === 1 ? "task" : "tasks"}`}
        </button>
      )}
    </>
  );
}

export function BackgroundTasksSurface({
  runtimeStatus,
  subagents,
  turns,
  commands,
  harnessId,
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
  const summary = backgroundTaskSummaryLabel(subagents, commands);
  const tokenTotal = backgroundTaskTokenTotalLabel(subagents);
  const note = subagents.length === 0 ? backgroundTaskEmptyNote(harnessId) : null;
  const attention = runtimeStatus === "online"
    ? null
    : runtimeStatus === "connecting"
      ? { title: "Connecting to workspace", detail: "Live task details may be incomplete." }
      : { title: "Workspace runtime unavailable", detail: "Live task details may be out of date." };
  return (
    <section
      className="workspace-surface background-tasks-surface"
      aria-label="Background tasks"
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
        <header className="background-tasks-header">
          <div className="workspace-surface-heading">
            <ListTree size={14} aria-hidden="true" />
            <h3>Background tasks</h3>
          </div>
          {summary && <p className="background-tasks-summary">{summary}</p>}
          {tokenTotal && (
            <>
              <p className="background-tasks-tokens" title={BACKGROUND_TASK_TOKENS_NOTE}>
                {tokenTotal}
              </p>
              <span className="visually-hidden">{BACKGROUND_TASK_TOKENS_NOTE}</span>
            </>
          )}
        </header>
        {subagents.length === 0 && commands.length === 0 && (
          <p className="background-tasks-empty">No background tasks in this chat.</p>
        )}
        {note && <p className="background-tasks-note">{note}</p>}
        {subagents.length > 0 && (
          <section className="background-tasks-section" aria-labelledby={`${surfaceId}-agents`}>
            <h4 id={`${surfaceId}-agents`}>Agents</h4>
            <BackgroundTaskAgents
              key={subagents[0]?.conversationId ?? turns[0]?.conversationId ?? "empty"}
              subagents={subagents}
              turns={turns}
              now={now}
              idPrefix={surfaceId}
              canFollowUpSubagent={canFollowUpSubagent}
              onFollowUpSubagent={onFollowUpSubagent}
              onOpenSubagent={onOpenSubagent}
              canStopSubagent={canStopSubagent}
              onStopSubagent={onStopSubagent}
            />
          </section>
        )}
        {commands.length > 0 && (
          <section className="background-tasks-section" aria-labelledby={`${surfaceId}-commands`}>
            <h4 id={`${surfaceId}-commands`}>Commands</h4>
            <ol className="background-tasks-list" aria-label="Commands">
              {commands.map((run) => (
                <CommandRow
                  key={run.id}
                  run={run}
                  now={now}
                  onStop={onStopCommand}
                  onDismiss={onDismissCommand}
                />
              ))}
            </ol>
          </section>
        )}
      </div>
    </section>
  );
}
