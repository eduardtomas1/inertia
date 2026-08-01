import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, MessageSquare, Network, Square } from "lucide-react";

import type {
  AgentTurn,
  SubagentTrace,
} from "@shared/contracts";
import {
  canFollowUpSubagentTrace,
  isLiveSubagentTrace,
  subagentElapsedMs,
  subagentDisclosureRows,
  subagentDisclosureSummary,
  subagentRelationshipLabel,
  subagentRouteLabel,
  subagentStatusLabel,
  subagentTraceLabel,
  subagentTraceSummary,
} from "../utils/subagentDisclosure";
import { formatElapsed } from "../utils/responseTimeline";
import { SubagentTraceDetails } from "./SubagentTraceDetails";

interface SubagentDisclosureProps {
  subagents: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
  onFollowUpSubagent?: (trace: SubagentTrace) => void;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
  now?: number;
}

function useDisclosureNow(
  hasLiveSubagents: boolean,
  fixedNow: number | undefined,
): number {
  const [now, setNow] = useState(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) {
      setNow(fixedNow);
      return;
    }
    if (!hasLiveSubagents) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [fixedNow, hasLiveSubagents]);
  return fixedNow ?? now;
}

export function SubagentDisclosure({
  subagents,
  turns,
  onFollowUpSubagent,
  onStopSubagent,
  onBeforeToggle,
  onAfterToggle,
  now: fixedNow,
}: SubagentDisclosureProps): React.JSX.Element | null {
  const hasLiveSubagents = subagents.some(isLiveSubagentTrace);
  const activeIdentity = subagents
    .filter(isLiveSubagentTrace)
    .map(({ id }) => id)
    .join("\0");
  const now = useDisclosureNow(hasLiveSubagents, fixedNow);
  const [open, setOpen] = useState(hasLiveSubagents);
  const [expandedTraceIds, setExpandedTraceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [stoppingTraceIds, setStoppingTraceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const previousActiveIdentity = useRef(activeIdentity);
  useEffect(() => {
    const previouslyActive = previousActiveIdentity.current.length > 0;
    const currentlyActive = activeIdentity.length > 0;
    if (!previouslyActive && currentlyActive) setOpen(true);
    if (previouslyActive && !currentlyActive) setOpen(false);
    previousActiveIdentity.current = activeIdentity;
  }, [activeIdentity]);
  const rows = useMemo(
    () => subagentDisclosureRows(subagents, turns),
    [subagents, turns],
  );
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
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        finishToggle();
      }}
    >
      <summary
        onPointerDown={() => onBeforeToggle?.()}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onBeforeToggle?.();
          setOpen((current) => !current);
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
      <ol aria-label="Delegated agent tree">
        {rows.map(({ trace, depth, canStop }) => {
          const detail = subagentTraceSummary(trace);
          const label = subagentTraceLabel(trace);
          const route = subagentRouteLabel(trace, turns);
          const state = subagentStatusLabel(trace);
          const relationship = subagentRelationshipLabel(trace, subagents);
          const canFollowUp = Boolean(
            onFollowUpSubagent
            && canFollowUpSubagentTrace(trace, turns),
          );
          const expanded = expandedTraceIds.has(trace.id);
          const stopping = stoppingTraceIds.has(trace.id);
          const detailId = `subagent-${trace.id}-details`;
          return (
            <li
              key={trace.id}
              data-status={trace.status}
              data-depth={depth}
              aria-label={`${label}, ${route}, ${state}`}
              style={{ "--subagent-depth": depth } as React.CSSProperties}
            >
              <span className="subagent-status-dot" aria-hidden="true" />
              <span className="subagent-copy">
                <span className="subagent-copy-heading">
                  <strong>{label}</strong>
                  <small
                    title={trace.providerStatus
                      ? `Exact provider state: ${trace.providerStatus}`
                      : undefined}
                  >
                    {route} · {state} ·{" "}
                    {formatElapsed(subagentElapsedMs(trace, now))}
                  </small>
                </span>
                {trace.parentTraceId && (
                  <small className="subagent-relationship">
                    {relationship}
                  </small>
                )}
                {detail && (
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
                <SubagentTraceDetails
                  id={detailId}
                  trace={trace}
                  traces={subagents}
                  turns={turns}
                />
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
