import { memo, useEffect, useRef, type CSSProperties } from "react";
import { Square } from "lucide-react";

import type { AgentTurn, SubagentTrace, WorkspaceRun } from "@shared/contracts";
import { useDocumentVisibility } from "../hooks/useDocumentPresence";
import { formatCompact } from "../lib/compactFormat";
import { formatCount } from "../lib/usageFormat";
import { backgroundCommandIsLive } from "../utils/backgroundTaskRuns";
import {
  backgroundCommandElapsedMs,
  backgroundCommandStateWord,
  backgroundTaskContextUsage,
  backgroundTaskDoingNow,
  backgroundTaskElapsedMs,
  backgroundTaskLatestStep,
  backgroundTaskProviderState,
  backgroundTaskStateWord,
  backgroundTaskTitle,
  backgroundTaskTokensNotReported,
  type BackgroundTaskStateWord,
} from "../utils/backgroundTasks";
import { formatElapsed } from "../utils/responseTimeline";
import { isLiveSubagentTrace, subagentRouteLabel } from "../utils/subagentDisclosure";
import { SubagentElapsed, subscribeLiveElapsed } from "./SubagentElapsed";

function KindLine({
  kind,
  state,
  children,
}: {
  kind: string;
  state: BackgroundTaskStateWord | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className="background-task-meta">
      <span className="background-task-value">
        {kind}
        {state && (
          <>
            {" · "}
            <span className={state.danger ? "background-task-danger" : undefined}>{state.word}</span>
          </>
        )}
      </span>
      {children}
    </span>
  );
}

function StopButton({
  title,
  stopping = false,
  onStop,
}: {
  title: string;
  stopping?: boolean;
  onStop: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="background-task-stop"
      data-focus-key="stop"
      aria-label={`${stopping ? "Stopping" : "Stop"} ${title}`}
      disabled={stopping}
      onClick={onStop}
    >
      <Square size={10} aria-hidden="true" />
    </button>
  );
}

function TaskDetails({
  id,
  trace,
  turns,
  now,
}: {
  id: string;
  trace: SubagentTrace;
  turns: readonly AgentTurn[];
  now?: number;
}): React.JSX.Element {
  const total = trace.usage?.totalTokens ?? null;
  const context = backgroundTaskContextUsage(trace.usage);
  const runtime = isLiveSubagentTrace(trace) ? undefined : backgroundTaskElapsedMs(trace, now ?? Date.now());
  const rows: [string, React.ReactNode][] = [
    ["Task", trace.description],
    ["Progress", trace.progress],
    ["Outcome", trace.result],
    ["Total tokens", total === null ? null : formatCount(total)],
    ["Tokens", backgroundTaskTokensNotReported(trace, turns)],
    ["Latest step", backgroundTaskLatestStep(trace.usage)?.join(" · ") ?? null],
    ["Context", context && (
      <span key="context" className="background-task-context">
        <span
          className="usage-surface-track is-context"
          role="meter"
          aria-label="Context window remaining"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={context.remainingPercent}
          aria-valuetext={context.label}
        >
          <i style={{ "--usage-remaining": `${context.remainingPercent}%` } as CSSProperties} />
        </span>
        {context.label}
      </span>
    )],
    ["Tool uses", trace.toolUseCount === null ? null : formatCount(trace.toolUseCount)],
    ["Runtime", runtime === undefined ? null : runtime === null ? "Not reported" : formatElapsed(runtime)],
    ["Route", subagentRouteLabel(trace, turns)],
    ["Provider state", backgroundTaskProviderState(trace)],
  ];
  return (
    <dl id={id} className="background-task-details">
      {rows.map(([label, value]) => value !== null && value !== "" && (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface AgentCardProps {
  trace: SubagentTrace;
  turns: readonly AgentTurn[];
  parentTitle: string | null;
  detailsId: string;
  expanded: boolean;
  stopping: boolean;
  now?: number;
  canOpen: boolean;
  canFollowUp: boolean;
  canStop: boolean;
  onToggle: (traceId: string) => void;
  onOpen: (traceId: string) => void;
  onFollowUp: (traceId: string) => void;
  onStop: (traceId: string) => void;
}

export const AgentCard = memo(function AgentCard({
  trace,
  turns,
  parentTitle,
  detailsId,
  expanded,
  stopping,
  now,
  canOpen,
  canFollowUp,
  canStop,
  onToggle,
  onOpen,
  onFollowUp,
  onStop,
}: AgentCardProps): React.JSX.Element {
  const title = backgroundTaskTitle(trace);
  const doing = backgroundTaskDoingNow(trace);
  const live = isLiveSubagentTrace(trace);
  const elapsed = live ? 0 : backgroundTaskElapsedMs(trace, now ?? Date.now());
  const total = trace.usage?.totalTokens ?? null;
  const facts = trace.model !== null || total !== null || trace.toolUseCount !== null;
  return (
    <li className="background-task-card" data-focus-row={`agent:${trace.id}`}>
      <button
        type="button"
        className="background-task-toggle"
        data-focus-key="details"
        aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined}
        onClick={() => onToggle(trace.id)}
      >
        <span className="background-task-title">{title}</span>
        <KindLine
          kind={parentTitle ? `Agent · from ${parentTitle}` : "Agent"}
          state={backgroundTaskStateWord(trace)}
        >
          {live
            ? <SubagentElapsed trace={trace} now={now} />
            : elapsed !== null && <span className="subagent-elapsed">{formatElapsed(elapsed)}</span>}
        </KindLine>
        {facts && (
          <span className="background-task-meta">
            {trace.model && <span className="background-task-value">{trace.model}</span>}
            {total !== null && (
              <span><span className="background-task-value">{formatCompact(total)}</span> tokens</span>
            )}
            {trace.toolUseCount !== null && (
              <span>
                <span className="background-task-value">{formatCount(trace.toolUseCount)}</span>
                {trace.toolUseCount === 1 ? " tool use" : " tool uses"}
              </span>
            )}
          </span>
        )}
      </button>
      {canStop && <StopButton title={title} stopping={stopping} onStop={() => onStop(trace.id)} />}
      {(doing || canOpen) && (
        <p className="background-task-doing">
          {doing && <span>{doing}</span>}
          {canOpen && (
            <button
              type="button"
              className="background-task-link"
              data-focus-key="open"
              aria-label={`View turn for ${title}`}
              onClick={() => onOpen(trace.id)}
            >
              View turn
            </button>
          )}
        </p>
      )}
      {expanded && (
        <div className="background-task-expanded">
          <TaskDetails id={detailsId} trace={trace} turns={turns} now={now} />
          {canFollowUp && (
            <button
              type="button"
              className="background-task-link"
              data-focus-key="guide"
              aria-label={`Guide parent about ${title}`}
              onClick={() => onFollowUp(trace.id)}
            >
              Guide parent
            </button>
          )}
        </div>
      )}
    </li>
  );
});

function CommandElapsed({
  run,
  now,
}: {
  run: WorkspaceRun;
  now?: number;
}): React.JSX.Element | null {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = backgroundCommandIsLive(run);
  const documentVisible = useDocumentVisibility();
  useEffect(() => {
    if (!live || now !== undefined || !documentVisible) return;
    return subscribeLiveElapsed(() => {
      const elapsed = backgroundCommandElapsedMs(run, Date.now());
      if (textRef.current && elapsed !== null) textRef.current.textContent = formatElapsed(elapsed);
    });
  }, [documentVisible, live, now, run]);
  const elapsed = backgroundCommandElapsedMs(run, now ?? Date.now());
  if (elapsed === null) return null;
  return <span ref={textRef} className="subagent-elapsed">{formatElapsed(elapsed)}</span>;
}

export const CommandCard = memo(function CommandCard({
  run,
  now,
  onStop,
}: {
  run: WorkspaceRun;
  now?: number;
  onStop?: (run: WorkspaceRun) => void;
}): React.JSX.Element {
  return (
    <li className="background-task-card" data-focus-row={`command:${run.id}`}>
      <div className="background-task-body">
        <span className="background-task-title">{run.label}</span>
        <KindLine kind="Command" state={backgroundCommandStateWord(run)}>
          <CommandElapsed run={run} now={now} />
        </KindLine>
      </div>
      {onStop && run.canStop && backgroundCommandIsLive(run) && (
        <StopButton title={run.label} onStop={() => onStop(run)} />
      )}
      {run.detail && <p className="background-task-doing"><span>{run.detail}</span></p>}
    </li>
  );
});
