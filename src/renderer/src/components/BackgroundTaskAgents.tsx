import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AgentTurn, SubagentTrace } from "@shared/contracts";
import { backgroundTaskGroups } from "../utils/backgroundTasks";
import { compactSubagentDisclosureRows } from "../utils/subagentCompactRows";
import {
  subagentDisclosureRows,
  subagentHasNestedParent,
  subagentRelationshipLabel,
  subagentRouteLabel,
  type SubagentDisclosureRow,
} from "../utils/subagentDisclosure";
import { compareSubagentTraces } from "../utils/terminalTurnProjection";
import { BackgroundTaskRow } from "./BackgroundTaskRow";

const MAX_COMPACT_FINISHED_TASKS = 5;

function traceById(traces: readonly SubagentTrace[], id: string): SubagentTrace | undefined {
  return traces.find((trace) => trace.id === id);
}

type AgentRow = SubagentDisclosureRow & { omittedAncestors: number };

export interface BackgroundTaskAgentsProps {
  subagents: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
  now?: number;
  idPrefix: string;
  headingId: string;
  canFollowUpSubagent?: (trace: SubagentTrace) => boolean;
  onFollowUpSubagent?: (trace: SubagentTrace) => void;
  onOpenSubagent?: (trace: SubagentTrace) => void;
  canStopSubagent?: (trace: SubagentTrace) => boolean;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
}

export function BackgroundTaskAgents({
  subagents,
  turns,
  now,
  idPrefix,
  headingId,
  canFollowUpSubagent,
  onFollowUpSubagent,
  onOpenSubagent,
  canStopSubagent,
  onStopSubagent,
}: BackgroundTaskAgentsProps): React.JSX.Element {
  const [showAllFinished, setShowAllFinished] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const sorted = useMemo(() => [...subagents].sort(compareSubagentTraces), [subagents]);
  const groups = useMemo(
    () => backgroundTaskGroups(subagentDisclosureRows(sorted, turns)),
    [sorted, turns],
  );
  const compactFinished = useMemo(
    () => compactSubagentDisclosureRows(groups.finished, MAX_COMPACT_FINISHED_TASKS),
    [groups.finished],
  );
  const latest = useRef({ sorted, stopping, onOpenSubagent, onFollowUpSubagent, onStopSubagent });
  useLayoutEffect(() => {
    latest.current = { sorted, stopping, onOpenSubagent, onFollowUpSubagent, onStopSubagent };
  });
  const toggleDetails = useCallback((id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  }), []);
  const open = useCallback((id: string) => {
    const trace = traceById(latest.current.sorted, id);
    if (trace) latest.current.onOpenSubagent?.(trace);
  }, []);
  const followUp = useCallback((id: string) => {
    const trace = traceById(latest.current.sorted, id);
    if (trace) latest.current.onFollowUpSubagent?.(trace);
  }, []);
  const stop = useCallback((id: string) => {
    const trace = traceById(latest.current.sorted, id);
    const onStop = latest.current.onStopSubagent;
    if (!trace || !onStop || latest.current.stopping.has(id)) return;
    setStopping((current) => new Set(current).add(id));
    void onStop(trace).catch(() => undefined).finally(() => {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    });
  }, []);
  const active = groups.active.map((row) => ({ ...row, omittedAncestors: 0 }));
  const finished = showAllFinished
    ? groups.finished.map((row) => ({ ...row, omittedAncestors: 0 }))
    : compactFinished;
  const hiddenFinished = groups.finished.length - compactFinished.length;
  const renderRow = ({ trace, depth, canStop, omittedAncestors }: AgentRow, index: number) => (
    <BackgroundTaskRow
      key={trace.id}
      trace={trace}
      turns={turns}
      route={subagentRouteLabel(trace, turns)}
      relationship={subagentRelationshipLabel(trace, sorted)}
      nested={subagentHasNestedParent(trace)}
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
      onToggleDetails={toggleDetails}
      onOpen={open}
      onFollowUp={followUp}
      onStop={stop}
    />
  );
  const group = (label: string, key: string, rows: readonly AgentRow[], offset: number) => (
    <div className="background-tasks-group">
      <span id={`${idPrefix}-${key}-label`} className="background-tasks-group-label">{label}</span>
      <ol
        id={`${idPrefix}-${key}`}
        className="background-tasks-list"
        aria-labelledby={`${idPrefix}-${key}-label`}
      >
        {rows.map((row, index) => renderRow(row, offset + index))}
      </ol>
    </div>
  );
  return (
    <section className="background-tasks-section" aria-labelledby={headingId}>
      <h4 id={headingId} tabIndex={-1} data-focus-heading="agent">Agents</h4>
      {active.length > 0 && group("Active", "active", active, 0)}
      {finished.length > 0 && group("Finished", "finished", finished, active.length)}
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
    </section>
  );
}
