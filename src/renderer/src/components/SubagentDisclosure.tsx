import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Network, Square } from "lucide-react";

import type {
  AgentTurn,
  SubagentTrace,
} from "@shared/contracts";
import {
  isLiveSubagentTrace,
  subagentElapsedMs,
  subagentDisclosureRows,
  subagentDisclosureSummary,
  subagentProviderLabel,
  subagentStatusLabel,
  subagentTraceDetail,
  subagentTraceLabel,
} from "../utils/subagentDisclosure";
import { formatElapsed } from "../utils/responseTimeline";

interface SubagentDisclosureProps {
  subagents: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
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
  onStopSubagent,
  now: fixedNow,
}: SubagentDisclosureProps): React.JSX.Element | null {
  const hasLiveSubagents = subagents.some(isLiveSubagentTrace);
  const activeIdentity = subagents
    .filter(isLiveSubagentTrace)
    .map(({ id }) => id)
    .join("\0");
  const now = useDisclosureNow(hasLiveSubagents, fixedNow);
  const [open, setOpen] = useState(hasLiveSubagents);
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
  if (subagents.length === 0) return null;
  return (
    <details
      className="subagent-disclosure"
      data-active={hasLiveSubagents}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        <Network size={13} aria-hidden="true" />
        <span className="subagent-summary-copy">
          <strong>{subagentDisclosureSummary(subagents)}</strong>
          <small>
            {[...new Set(subagents.map(subagentProviderLabel))].join(" · ")}
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
          const detail = subagentTraceDetail(trace);
          const label = subagentTraceLabel(trace);
          const provider = subagentProviderLabel(trace);
          const state = subagentStatusLabel(trace);
          const parent = trace.parentTraceId
            ? subagents.find(({ id }) => id === trace.parentTraceId)
            : undefined;
          return (
            <li
              key={trace.id}
              data-status={trace.status}
              data-depth={depth}
              aria-label={`${label}, ${provider}, ${state}`}
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
                    {provider} · {state} ·{" "}
                    {formatElapsed(subagentElapsedMs(trace, now))}
                  </small>
                </span>
                {parent && (
                  <span className="visually-hidden">
                    Child of {subagentTraceLabel(parent)}.
                  </span>
                )}
                {detail && (
                  <small className="subagent-detail" title={detail}>
                    {detail}
                  </small>
                )}
              </span>
              {canStop && onStopSubagent && (
                <button
                  type="button"
                  className="subagent-stop-button"
                  aria-label={`Stop ${label}`}
                  onClick={() => {
                    void onStopSubagent(trace).catch(() => undefined);
                  }}
                >
                  <Square size={10} fill="currentColor" />
                  Stop
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
