import { useEffect, useMemo, useRef, useState } from "react";
import {
  GitBranch,
  Globe2,
  MessageSquareText,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import type { WorkspaceRun } from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";
import { useDocumentVisibility } from "../hooks/useDocumentPresence";
import { backgroundCommandIsLive } from "../utils/backgroundTaskRuns";
import {
  backgroundCommandElapsedMs,
  backgroundCommandStatusLabel,
  orderedBackgroundCommands,
} from "../utils/backgroundTasks";
import { formatElapsed } from "../utils/responseTimeline";
import { subscribeLiveElapsed } from "./SubagentElapsed";

const MAX_COMPACT_FINISHED_COMMANDS = 5;

const commandIcons: Record<WorkspaceRun["kind"], React.JSX.Element> = {
  agent: <MessageSquareText size={12} aria-hidden="true" />,
  check: <SquareTerminal size={12} aria-hidden="true" />,
  service: <Globe2 size={12} aria-hidden="true" />,
  "source-control": <GitBranch size={12} aria-hidden="true" />,
};

function CommandElapsed({
  run,
  now,
}: {
  run: WorkspaceRun;
  now?: number;
}): React.JSX.Element {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = backgroundCommandIsLive(run);
  const documentVisible = useDocumentVisibility();
  useEffect(() => {
    if (!live || now !== undefined || !documentVisible) return;
    return subscribeLiveElapsed(() => {
      const elapsed = backgroundCommandElapsedMs(run, Date.now());
      if (textRef.current && elapsed !== null) {
        textRef.current.textContent = formatElapsed(elapsed);
      }
    });
  }, [documentVisible, live, now, run]);
  const elapsed = backgroundCommandElapsedMs(run, now ?? Date.now());
  if (elapsed === null) {
    return (
      <span className="subagent-elapsed">
        <span aria-hidden="true">—</span>
        <span className="visually-hidden">Runtime not reported</span>
      </span>
    );
  }
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
  const status = backgroundCommandStatusLabel(run.status);
  const live = backgroundCommandIsLive(run);
  const canDismiss = Boolean(onDismiss && workspaceRunAttentionView(run).canDismiss);
  const canStop = Boolean(onStop && run.canStop && live);
  return (
    <li
      className="background-task-row is-command"
      data-run-id={run.id}
      data-focus-row={`command:${run.id}`}
      data-status={run.status}
      data-live={live}
      aria-label={`${run.label}, ${status}`}
    >
      <span className="background-command-mark" data-status={run.status} aria-hidden="true">
        {commandIcons[run.kind]}
      </span>
      <div className="background-task-main">
        <div className="background-task-heading">
          <strong>{run.label}</strong>
          <span className="background-task-status">{status}</span>
        </div>
        {run.detail && <p className="background-task-doing">{run.detail}</p>}
      </div>
      <div className="background-task-metrics">
        <CommandElapsed run={run} now={now} />
      </div>
      {(canStop || canDismiss) && (
        <div className="background-task-actions">
          {canStop && (
            <button
              type="button"
              data-focus-key="stop"
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
              data-focus-key="dismiss"
              aria-label={`Dismiss ${run.label}`}
              onClick={() => onDismiss?.(run)}
            >
              <Trash2 size={11} aria-hidden="true" />
              Dismiss
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function BackgroundTaskCommands({
  commands,
  now,
  headingId,
  listId,
  onStop,
  onDismiss,
}: {
  commands: readonly WorkspaceRun[];
  now?: number;
  headingId: string;
  listId: string;
  onStop?: (run: WorkspaceRun) => void;
  onDismiss?: (run: WorkspaceRun) => void;
}): React.JSX.Element {
  const [showAllFinished, setShowAllFinished] = useState(false);
  const ordered = useMemo(() => orderedBackgroundCommands(commands), [commands]);
  const live = ordered.filter(backgroundCommandIsLive);
  const finished = ordered.filter((run) => !backgroundCommandIsLive(run));
  const hiddenFinished = Math.max(0, finished.length - MAX_COMPACT_FINISHED_COMMANDS);
  const visible = [
    ...live,
    ...(showAllFinished ? finished : finished.slice(0, MAX_COMPACT_FINISHED_COMMANDS)),
  ];
  return (
    <section className="background-tasks-section" aria-labelledby={headingId}>
      <h4 id={headingId} tabIndex={-1} data-focus-heading="command">Commands</h4>
      <ol id={listId} className="background-tasks-list" aria-label="Commands">
        {visible.map((run) => (
          <CommandRow key={run.id} run={run} now={now} onStop={onStop} onDismiss={onDismiss} />
        ))}
      </ol>
      {hiddenFinished > 0 && (
        <button
          type="button"
          className="background-tasks-toggle"
          aria-controls={listId}
          aria-expanded={showAllFinished}
          onClick={() => setShowAllFinished((current) => !current)}
        >
          {showAllFinished
            ? "Show fewer finished commands"
            : `Show ${hiddenFinished} more finished ${hiddenFinished === 1 ? "command" : "commands"}`}
        </button>
      )}
    </section>
  );
}
