import { useId, useLayoutEffect, useMemo, useRef } from "react";
import { Laptop, ListTree } from "lucide-react";

import type { AgentTurn, SubagentTrace, WorkspaceRun } from "@shared/contracts";
import { backgroundCommandRuns } from "../utils/backgroundTaskRuns";
import {
  BACKGROUND_TASK_TOKENS_NOTE,
  backgroundTaskEmptyNote,
  backgroundTaskSummaryLabel,
  backgroundTaskTokenTotalLabel,
} from "../utils/backgroundTasks";
import type { EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { BackgroundTaskAgents } from "./BackgroundTaskAgents";
import { BackgroundTaskCommands } from "./BackgroundTaskCommands";
import "./BeautifulUiMotion.css";
import "./WorkspaceSurfaces.css";
import "./BackgroundTasksSurface.css";

export interface BackgroundTasksSurfaceProps {
  runtimeStatus: EnvironmentSummarySnapshot["runtime"]["status"];
  subagents: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
  runs: readonly WorkspaceRun[];
  conversation: { id: string; modelSelection: { harnessId: string } } | null;
  now?: number;
  canFollowUpSubagent?: (trace: SubagentTrace) => boolean;
  onFollowUpSubagent?: (trace: SubagentTrace) => void;
  onOpenSubagent?: (trace: SubagentTrace) => void;
  canStopSubagent?: (trace: SubagentTrace) => boolean;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
  onStopCommand?: (run: WorkspaceRun) => void;
  onDismissCommand?: (run: WorkspaceRun) => void;
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
      ?? row?.querySelector<HTMLElement>("button:not(:disabled)")
      ?? region.querySelector<HTMLElement>(`[data-focus-heading="${current.row.split(":")[0]}"]`)
      ?? region.querySelector<HTMLElement>("[data-focus-heading]");
    control?.focus();
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

export function BackgroundTasksSurface({
  runtimeStatus,
  subagents,
  turns,
  runs,
  conversation,
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
  const conversationId = conversation?.id ?? null;
  const commands = useMemo(
    () => backgroundCommandRuns(runs, conversationId, turns),
    [conversationId, runs, turns],
  );
  const harnessId = turns.at(-1)?.harnessId ?? conversation?.modelSelection.harnessId ?? null;
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
        <header className="background-tasks-header">
          <div className="workspace-surface-heading">
            <ListTree size={14} aria-hidden="true" />
            <h3 tabIndex={-1} data-focus-heading="surface">Background tasks</h3>
          </div>
          {summary && <p className="background-tasks-summary">{summary}</p>}
          {tokenTotal && (
            <>
              <p className="background-tasks-tokens">{tokenTotal}</p>
              <p className="background-tasks-tokens-note">{BACKGROUND_TASK_TOKENS_NOTE}</p>
            </>
          )}
        </header>
        {subagents.length === 0 && commands.length === 0 && (
          <p className="background-tasks-empty">No background tasks in this chat.</p>
        )}
        {note && <p className="background-tasks-note">{note}</p>}
        {subagents.length > 0 && (
          <BackgroundTaskAgents
            key={`agents:${conversationId ?? subagents[0]?.conversationId ?? ""}`}
            subagents={subagents}
            turns={turns}
            now={now}
            idPrefix={surfaceId}
            headingId={`${surfaceId}-agents`}
            canFollowUpSubagent={canFollowUpSubagent}
            onFollowUpSubagent={onFollowUpSubagent}
            onOpenSubagent={onOpenSubagent}
            canStopSubagent={canStopSubagent}
            onStopSubagent={onStopSubagent}
          />
        )}
        {commands.length > 0 && (
          <BackgroundTaskCommands
            key={`commands:${conversationId ?? ""}`}
            commands={commands}
            now={now}
            headingId={`${surfaceId}-commands`}
            listId={`${surfaceId}-commands-list`}
            onStop={onStopCommand}
            onDismiss={onDismissCommand}
          />
        )}
      </div>
    </section>
  );
}
