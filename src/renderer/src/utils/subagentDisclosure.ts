import type {
  AgentTurn,
  SubagentTrace,
} from "@shared/contracts";
import { supportsActiveParentFollowUp } from "./composerPrimaryAction";

export interface SubagentDisclosureRow {
  trace: SubagentTrace;
  depth: number;
  canStop: boolean;
}

export function isLiveSubagentTrace(trace: SubagentTrace): boolean {
  return trace.isLive;
}

export function canStopSubagentTrace(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): boolean {
  const turn = turns.find(({ id }) => id === trace.turnId);
  return Boolean(
    turn
    && ![
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(turn.status)
    && turn.harnessId === "claude-agent-sdk"
    && trace.providerId === "claude"
    && trace.providerTaskId
    && isLiveSubagentTrace(trace),
  );
}

export function canFollowUpSubagentTrace(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): boolean {
  const turn = turns.find(({ id }) => id === trace.turnId);
  return Boolean(
    turn
    && (
      turn.status === "running"
      || turn.status === "waiting-for-approval"
      || turn.status === "waiting-for-input"
    )
    && supportsActiveParentFollowUp(turn.harnessId)
    && isLiveSubagentTrace(trace),
  );
}

export function subagentProviderLabel(trace: SubagentTrace): string {
  if (trace.providerId === "codex") return "Codex";
  if (trace.providerId === "claude") return "Claude";
  if (trace.providerId === "cursor") return "Cursor";
  return "OpenCode";
}

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  "codex-app-server": "App Server",
  "codex-cli": "CLI",
  "claude-agent-sdk": "Agent SDK",
  "claude-cli": "CLI",
  "cursor-acp": "ACP",
  "cursor-cli": "CLI",
  "opencode-sdk": "SDK",
  "opencode-cli": "CLI",
};

export function subagentHarnessLabel(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): string {
  const harnessId = turns.find(({ id }) => id === trace.turnId)?.harnessId;
  if (!harnessId) return "historical harness unavailable";
  return HARNESS_LABELS[harnessId] ?? harnessId;
}

export function subagentRouteLabel(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): string {
  return `${subagentProviderLabel(trace)} · ${subagentHarnessLabel(trace, turns)}`;
}

export function subagentTraceLabel(trace: SubagentTrace): string {
  return trace.providerName
    ?? trace.providerRole
    ?? `${subagentProviderLabel(trace)} delegated task`;
}

export function subagentStatusLabel(trace: SubagentTrace): string {
  const normalized = trace.status === "queued"
    ? "Queued"
    : trace.status === "spawned"
      ? "Starting"
      : trace.status === "running"
        ? "Running"
        : trace.status === "waiting"
          ? "Waiting"
          : trace.status === "completed"
            ? "Completed"
            : trace.status === "failed"
              ? "Failed"
              : trace.status === "cancelled"
                ? "Cancelled"
                : trace.status === "interrupted"
                  ? "Interrupted"
                  : trace.status === "lost"
                    ? "Lost"
                    : "Unknown";
  return trace.providerStatus && trace.providerStatus !== trace.status
    ? `${normalized} (${trace.providerStatus})`
    : normalized;
}

export function subagentTraceDetail(trace: SubagentTrace): string | null {
  return isLiveSubagentTrace(trace)
    ? trace.progress ?? trace.description ?? trace.result
    : trace.result ?? trace.progress ?? trace.description;
}

const MAX_SUBAGENT_SUMMARY_CHARS = 280;

export function subagentTraceSummary(trace: SubagentTrace): string | null {
  const detail = subagentTraceDetail(trace);
  if (!detail || detail.length <= MAX_SUBAGENT_SUMMARY_CHARS) return detail;
  return `${detail.slice(0, MAX_SUBAGENT_SUMMARY_CHARS - 1).trimEnd()}…`;
}

export function subagentRelationshipLabel(
  trace: SubagentTrace,
  traces: readonly SubagentTrace[],
): string {
  const parent = trace.parentTraceId
    ? traces.find(({ id }) => id === trace.parentTraceId)
    : undefined;
  return parent
    ? `Child of ${subagentTraceLabel(parent)}`
    : "Delegated by this parent turn";
}

export function subagentElapsedMs(
  trace: SubagentTrace,
  now: number,
): number {
  const startedAt = Date.parse(trace.createdAt);
  const updatedAt = Date.parse(trace.updatedAt);
  if (!Number.isFinite(startedAt)) return 0;
  const end = isLiveSubagentTrace(trace) || !Number.isFinite(updatedAt)
    ? now
    : updatedAt;
  return Math.max(0, end - startedAt);
}

export function subagentDisclosureRows(
  traces: readonly SubagentTrace[],
  turns: readonly AgentTurn[],
): SubagentDisclosureRow[] {
  const byParent = new Map<string | null, SubagentTrace[]>();
  const knownIds = new Set(traces.map(({ id }) => id));
  for (const trace of traces) {
    const parentId = trace.parentTraceId && knownIds.has(trace.parentTraceId)
      ? trace.parentTraceId
      : null;
    const children = byParent.get(parentId) ?? [];
    children.push(trace);
    byParent.set(parentId, children);
  }
  const rows: SubagentDisclosureRow[] = [];
  const visited = new Set<string>();
  const append = (trace: SubagentTrace, depth: number): void => {
    if (visited.has(trace.id)) return;
    visited.add(trace.id);
    rows.push({
      trace,
      depth: Math.min(depth, 8),
      canStop: canStopSubagentTrace(trace, turns),
    });
    for (const child of byParent.get(trace.id) ?? []) {
      append(child, depth + 1);
    }
  };
  for (const root of byParent.get(null) ?? []) append(root, 0);
  for (const trace of traces) append(trace, 0);
  return rows;
}

export function subagentDisclosureSummary(
  traces: readonly SubagentTrace[],
): string {
  const live = traces.filter(isLiveSubagentTrace).length;
  const noun = traces.length === 1 ? "delegated task" : "delegated tasks";
  return live > 0
    ? `${traces.length} ${noun} · ${live} active`
    : `${traces.length} ${noun}`;
}
