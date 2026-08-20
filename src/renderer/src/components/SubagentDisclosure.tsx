import { useId, useMemo, useState } from "react";
import { ChevronDown, MessageSquare, Network, Square } from "lucide-react";

import type {
  AgentTurn,
  SubagentTrace,
} from "@shared/contracts";
import {
  canFollowUpSubagentTrace,
  isLiveSubagentTrace,
  subagentDisclosureRows,
  subagentDisclosureSummary,
  subagentHasNestedParent,
  subagentMissionSummary,
  subagentNeedsReview,
  subagentRelationshipLabel,
  subagentRoleLabel,
  subagentRouteLabel,
  subagentStatusLabel,
  subagentTraceLabel,
  subagentTraceSummary,
  urgentSubagentBranchEndpoints,
} from "../utils/subagentDisclosure";
import type { SubagentDisclosureRow } from "../utils/subagentDisclosure";
import {
  readSubagentDisclosureOpen,
  writeSubagentDisclosureOpen,
} from "../utils/subagentDisclosurePreference";
import { SubagentElapsed } from "./SubagentElapsed";
import { SubagentStatusMark } from "./SubagentStatusMark";
import { SubagentTraceDetails } from "./SubagentTraceDetails";

interface SubagentDisclosureProps {
  conversationId: string;
  turnId: string;
  subagents: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
  onFollowUpSubagent?: (trace: SubagentTrace) => void;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
  now?: number;
}

const MAX_INLINE_SUBAGENTS = 6;

function rendererLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function compactInlineRows(
  rows: readonly SubagentDisclosureRow[],
): Array<SubagentDisclosureRow & { omittedAncestors: number }> {
  if (rows.length <= MAX_INLINE_SUBAGENTS) {
    return rows.map((row) => ({ ...row, omittedAncestors: 0 }));
  }
  const byId = new Map(rows.map((row) => [row.trace.id, row]));
  const prioritized = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftUrgent = Number(
        isLiveSubagentTrace(left.row.trace)
          || subagentNeedsReview(left.row.trace),
      );
      const rightUrgent = Number(
        isLiveSubagentTrace(right.row.trace)
          || subagentNeedsReview(right.row.trace),
      );
      return rightUrgent - leftUrgent
        || right.row.trace.sequence - left.row.trace.sequence
        || right.index - left.index;
    })
    .map(({ row }) => row);
  const selected = new Set(urgentSubagentBranchEndpoints(prioritized)
    .slice(0, MAX_INLINE_SUBAGENTS)
    .map(({ trace }) => trace.id));
  for (const { trace } of prioritized) {
    if (selected.size >= MAX_INLINE_SUBAGENTS) break;
    selected.add(trace.id);
  }
  const visibleDepth = new Map<string, number>();
  return rows
    .filter(({ trace }) => selected.has(trace.id))
    .map((row) => {
      let omittedAncestors = 0;
      let parentId = row.trace.parentTraceId;
      const visited = new Set<string>();
      while (parentId && !selected.has(parentId) && !visited.has(parentId)) {
        visited.add(parentId);
        omittedAncestors += 1;
        parentId = byId.get(parentId)?.trace.parentTraceId ?? null;
      }
      const parentDepth = row.trace.parentTraceId
        ? visibleDepth.get(row.trace.parentTraceId)
        : undefined;
      const depth = parentDepth === undefined ? 0 : Math.min(parentDepth + 1, 8);
      visibleDepth.set(row.trace.id, depth);
      return { ...row, depth, omittedAncestors };
    });
}

export function SubagentDisclosure({
  conversationId,
  turnId,
  subagents,
  turns,
  onFollowUpSubagent,
  onStopSubagent,
  onBeforeToggle,
  onAfterToggle,
  now: fixedNow,
}: SubagentDisclosureProps): React.JSX.Element | null {
  const disclosureId = useId();
  const listId = `${disclosureId}-subagent-list`;
  const hasLiveSubagents = subagents.some(isLiveSubagentTrace);
  const hasReviewableOutcome = subagents.some(subagentNeedsReview);
  const [open, setOpen] = useState(() => {
    const storage = rendererLocalStorage();
    return storage
      ? readSubagentDisclosureOpen(storage, { conversationId, turnId })
      : false;
  });
  const [showAll, setShowAll] = useState(false);
  const [expandedTraceIds, setExpandedTraceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [stoppingTraceIds, setStoppingTraceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const rows = useMemo(
    () => subagentDisclosureRows(subagents, turns),
    [subagents, turns],
  );
  const compactRows = useMemo(
    () => compactInlineRows(rows),
    [rows],
  );
  const visibleRows = showAll
    ? rows.map((row) => ({ ...row, omittedAncestors: 0 }))
    : compactRows;
  const hiddenCount = rows.length - compactRows.length;
  const updateOpen = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    const storage = rendererLocalStorage();
    if (storage) {
      writeSubagentDisclosureOpen(
        storage,
        { conversationId, turnId },
        nextOpen,
      );
    }
  };
  const finishToggle = (): void => {
    if (!onAfterToggle) return;
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  const toggleTraceDetails = (traceId: string): void => {
    onBeforeToggle?.();
    setExpandedTraceIds((current) => {
      const next = new Set(current);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
    finishToggle();
  };
  const stopTrace = async (trace: SubagentTrace): Promise<void> => {
    if (!onStopSubagent || stoppingTraceIds.has(trace.id)) return;
    setStoppingTraceIds((current) => new Set(current).add(trace.id));
    try {
      await onStopSubagent(trace);
    } finally {
      setStoppingTraceIds((current) => {
        const next = new Set(current);
        next.delete(trace.id);
        return next;
      });
    }
  };
  if (subagents.length === 0) return null;
  return (
    <details
      className="subagent-disclosure"
      data-active={hasLiveSubagents}
      data-needs-review={hasReviewableOutcome}
      open={open}
      onToggle={(event) => {
        updateOpen(event.currentTarget.open);
        finishToggle();
      }}
    >
      <summary
        onClick={(event) => {
          // Chromium dispatches the native details toggle after click. Persist
          // during activation so an immediate reload cannot overtake it.
          event.preventDefault();
          updateOpen(!open);
        }}
        onPointerDown={() => onBeforeToggle?.()}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onBeforeToggle?.();
          updateOpen(!open);
        }}
      >
        <Network size={13} aria-hidden="true" />
        <span className="subagent-summary-copy">
          <strong>{subagentDisclosureSummary(subagents)}</strong>
          <small>
            {[...new Set(subagents.map((trace) =>
              subagentRouteLabel(trace, turns)))].join(" · ")}
          </small>
        </span>
        <ChevronDown
          className="subagent-disclosure-chevron"
          size={12}
          aria-hidden="true"
        />
      </summary>
      <ol id={listId} aria-label="Delegated agent tree">
        {visibleRows.map(({ trace, depth, canStop, omittedAncestors }, index) => {
          const detail = subagentTraceSummary(trace);
          const label = subagentTraceLabel(trace);
          const mission = subagentMissionSummary(trace);
          const role = subagentRoleLabel(trace);
          const route = subagentRouteLabel(trace, turns);
          const state = subagentStatusLabel(trace);
          const relationship = subagentRelationshipLabel(trace, subagents);
          const canFollowUp = Boolean(
            onFollowUpSubagent
            && canFollowUpSubagentTrace(trace, turns),
          );
          const expanded = expandedTraceIds.has(trace.id);
          const stopping = stoppingTraceIds.has(trace.id);
          const detailId = `${disclosureId}-${trace.id}-details`;
          return (
            <li
              key={trace.id}
              data-status={trace.status}
              data-depth={depth}
              data-expanded={expanded ? "true" : "false"}
              aria-label={`${label}, ${mission ? `${mission}, ` : ""}${route}, ${state}`}
              style={{
                "--subagent-depth": depth,
                "--motion-index": Math.min(index, 6),
              } as React.CSSProperties}
            >
              <SubagentStatusMark key={trace.status} trace={trace} />
              <span className="subagent-copy">
                <span className="subagent-copy-heading">
                  <strong>{label}</strong>
                  {role && (
                    <span className="subagent-role">{role}</span>
                  )}
                  <span className="subagent-state-pill" key={trace.status}>
                    {state}
                  </span>
                </span>
                {mission && (
                  <small className="subagent-mission" title={mission}>
                    {mission}
                  </small>
                )}
                <small
                  className="subagent-route"
                  title={trace.providerStatus
                    ? `Exact provider state: ${trace.providerStatus}`
                    : undefined}
                >
                  {route} · <SubagentElapsed trace={trace} now={fixedNow} />
                </small>
                {subagentHasNestedParent(trace) && (
                  <small className="subagent-relationship">
                    {relationship}
                  </small>
                )}
                {omittedAncestors > 0 && (
                  <small className="subagent-relationship">
                    {omittedAncestors} earlier {omittedAncestors === 1
                      ? "ancestor"
                      : "ancestors"} compacted
                  </small>
                )}
                {detail && detail !== mission && (
                  <small className="subagent-detail" title={detail}>
                    {detail}
                  </small>
                )}
              </span>
              <span className="subagent-row-actions">
                {canFollowUp && (
                  <button
                    type="button"
                    className="subagent-guide-button"
                    title="Draft guidance to the active parent; nothing is sent yet."
                    onClick={() => onFollowUpSubagent?.(trace)}
                  >
                    <MessageSquare size={11} aria-hidden="true" />
                    Guide parent
                  </button>
                )}
                <button
                  type="button"
                  className="subagent-details-button"
                  aria-controls={detailId}
                  aria-expanded={expanded}
                  onClick={() => toggleTraceDetails(trace.id)}
                >
                  Details
                  <ChevronDown size={11} aria-hidden="true" />
                </button>
                {canStop && onStopSubagent && (
                  <button
                    type="button"
                    className="subagent-stop-button"
                    aria-label={`${stopping ? "Stopping" : "Stop"} ${label}`}
                    disabled={stopping}
                    onClick={() => {
                      void stopTrace(trace).catch(() => undefined);
                    }}
                  >
                    <Square size={10} fill="currentColor" aria-hidden="true" />
                    {stopping ? "Stopping…" : "Stop"}
                  </button>
                )}
              </span>
              {expanded && (
                <div className="subagent-detail-reveal">
                  <SubagentTraceDetails
                    id={detailId}
                    trace={trace}
                    traces={subagents}
                    turns={turns}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="subagent-history-toggle"
          aria-controls={listId}
          aria-expanded={showAll}
          onClick={() => {
            onBeforeToggle?.();
            setShowAll((current) => !current);
            finishToggle();
          }}
        >
          {showAll
            ? "Show compact delegated work"
            : `Show ${hiddenCount} more delegated ${hiddenCount === 1
              ? "task"
              : "tasks"}`}
        </button>
      )}
    </details>
  );
}
