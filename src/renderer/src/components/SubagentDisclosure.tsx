import { Network, Square } from "lucide-react";

import type {
  AgentTurn,
  SubagentTrace,
  SubagentTraceStatus,
} from "@shared/contracts";
import {
  subagentDisclosureRows,
  subagentDisclosureSummary,
} from "../utils/subagentDisclosure";

interface SubagentDisclosureProps {
  subagents: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
}

function statusLabel(status: SubagentTraceStatus): string {
  if (status === "spawned") return "Starting";
  if (status === "running") return "Working";
  if (status === "waiting") return "Waiting";
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Stopped";
  return "Lost";
}

function traceLabel(trace: SubagentTrace): string {
  return trace.providerName
    ?? trace.providerRole
    ?? (trace.providerId === "codex" ? "Codex subagent" : "Claude task");
}

export function SubagentDisclosure({
  subagents,
  turns,
  onStopSubagent,
}: SubagentDisclosureProps): React.JSX.Element | null {
  if (subagents.length === 0) return null;
  const rows = subagentDisclosureRows(subagents, turns);
  return (
    <details
      className="subagent-disclosure"
      data-active={subagents.some(({ status }) =>
        status === "spawned" || status === "running" || status === "waiting")}
    >
      <summary>
        <Network size={13} aria-hidden="true" />
        <span>{subagentDisclosureSummary(subagents)}</span>
      </summary>
      <ol aria-label="Delegated agent work">
        {rows.map(({ trace, depth, canStop }) => {
          const detail = trace.result ?? trace.progress ?? trace.description;
          return (
            <li
              key={trace.id}
              data-status={trace.status}
              style={{ "--subagent-depth": depth } as React.CSSProperties}
            >
              <span className="subagent-status-dot" aria-hidden="true" />
              <span className="subagent-copy">
                <span>
                  <strong>{traceLabel(trace)}</strong>
                  <small>{statusLabel(trace.status)}</small>
                </span>
                {detail && <small title={detail}>{detail}</small>}
              </span>
              {canStop && onStopSubagent && (
                <button
                  type="button"
                  className="subagent-stop-button"
                  aria-label={`Stop ${traceLabel(trace)}`}
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
