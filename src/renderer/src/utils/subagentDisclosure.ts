import type {
  AgentTurn,
  SubagentTrace,
  SubagentTraceStatus,
} from "@shared/contracts";

export interface SubagentDisclosureRow {
  trace: SubagentTrace;
  depth: number;
  canStop: boolean;
}

const LIVE_STATUSES = new Set<SubagentTraceStatus>([
  "queued",
  "spawned",
  "running",
  "waiting",
]);

export function isLiveSubagentTrace(trace: SubagentTrace): boolean {
  return LIVE_STATUSES.has(trace.status);
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

export function subagentProviderLabel(trace: SubagentTrace): string {
  if (trace.providerId === "codex") return "Codex";
  if (trace.providerId === "claude") return "Claude";
  if (trace.providerId === "cursor") return "Cursor";
  return "OpenCode";
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
