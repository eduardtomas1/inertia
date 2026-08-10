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

export interface SubagentDisclosureStats {
  total: number;
  active: number;
  completed: number;
  stopped: number;
  needsReview: number;
}

export function isLiveSubagentTrace(trace: SubagentTrace): boolean {
  return trace.isLive;
}

export function subagentNeedsReview(trace: SubagentTrace): boolean {
  return !trace.isLive && (
    trace.status === "failed"
    || trace.status === "interrupted"
    || trace.status === "lost"
    || trace.status === "unknown"
  );
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

const LIVE_PROVIDER_STATUSES = new Set([
  "pending",
  "pendinginit",
  "queued",
  "spawned",
  "running",
  "inprogress",
  "paused",
  "waiting",
  "started",
  "interacted",
  "asynclaunched",
]);

const EQUIVALENT_PROVIDER_STATUSES: Readonly<
  Record<SubagentTrace["status"], ReadonlySet<string>>
> = {
  queued: new Set(["pending", "pendinginit", "queued"]),
  spawned: new Set(["spawned", "starting"]),
  running: new Set([
    "running",
    "inprogress",
    "started",
    "interacted",
    "asynclaunched",
  ]),
  waiting: new Set(["paused", "waiting"]),
  completed: new Set(["completed", "success", "succeeded"]),
  failed: new Set(["error", "failed"]),
  cancelled: new Set(["canceled", "cancelled", "killed", "shutdown", "stopped"]),
  interrupted: new Set(["interrupted"]),
  lost: new Set(["lost"]),
  unknown: new Set(),
};

function normalizedProviderStatus(status: string): string {
  return status.toLowerCase().replaceAll(/[-_\s]/gu, "");
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
  const providerStatus = trace.providerStatus?.trim();
  const providerStatusKey = providerStatus
    ? normalizedProviderStatus(providerStatus)
    : null;
  const contradictsTerminalState = !trace.isLive
    && providerStatusKey
    && LIVE_PROVIDER_STATUSES.has(providerStatusKey);
  const repeatsNormalizedState = providerStatusKey
    ? EQUIVALENT_PROVIDER_STATUSES[trace.status].has(providerStatusKey)
    : false;
  return providerStatus
    && !repeatsNormalizedState
    && !contradictsTerminalState
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
  if (parent) return `Child of ${subagentTraceLabel(parent)}`;
  if (
    trace.parentTraceId
    || trace.parentProviderAgentId
    || trace.parentProviderToolUseId
  ) {
    return "Nested delegated task · parent unavailable";
  }
  return "Delegated by parent agent";
}

export function subagentHasNestedParent(trace: SubagentTrace): boolean {
  return Boolean(
    trace.parentTraceId
    || trace.parentProviderAgentId
    || trace.parentProviderToolUseId,
  );
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

export function urgentSubagentBranchEndpoints(
  rows: readonly SubagentDisclosureRow[],
): SubagentDisclosureRow[] {
  const byId = new Map(rows.map((row) => [row.trace.id, row]));
  const urgent = rows.filter(({ trace }) =>
    isLiveSubagentTrace(trace) || subagentNeedsReview(trace));
  const urgentIds = new Set(urgent.map(({ trace }) => trace.id));
  const urgentAncestors = new Set<string>();
  for (const { trace } of urgent) {
    let parentId = trace.parentTraceId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (urgentIds.has(parentId)) urgentAncestors.add(parentId);
      parentId = byId.get(parentId)?.trace.parentTraceId ?? null;
    }
  }
  return urgent.filter(({ trace }) => !urgentAncestors.has(trace.id));
}

export function subagentDisclosureStats(
  traces: readonly SubagentTrace[],
): SubagentDisclosureStats {
  let active = 0;
  let completed = 0;
  let stopped = 0;
  let needsReview = 0;
  for (const trace of traces) {
    if (isLiveSubagentTrace(trace)) active += 1;
    else if (trace.status === "completed") completed += 1;
    else if (trace.status === "cancelled") stopped += 1;
    else if (subagentNeedsReview(trace)) needsReview += 1;
  }
  return { total: traces.length, active, completed, stopped, needsReview };
}

export function subagentStatsLabel(stats: SubagentDisclosureStats): string {
  const labels: string[] = [];
  if (stats.active > 0) labels.push(`${stats.active} working`);
  if (stats.needsReview > 0) labels.push(`${stats.needsReview} needs review`);
  const settled = stats.completed + stats.stopped;
  if (settled > 0) labels.push(`${settled} settled`);
  return labels.join(" · ");
}

export function subagentDisclosureSummary(
  traces: readonly SubagentTrace[],
): string {
  const stats = subagentDisclosureStats(traces);
  const noun = traces.length === 1 ? "delegated task" : "delegated tasks";
  const state = subagentStatsLabel(stats);
  return state
    ? `${traces.length} ${noun} · ${state}`
    : `${traces.length} ${noun}`;
}
