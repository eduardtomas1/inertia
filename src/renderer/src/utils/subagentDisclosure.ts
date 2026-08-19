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
  return !trace.isLive
    && ["failed", "interrupted", "lost", "unknown"].includes(trace.status);
}

export function canStopSubagentTrace(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): boolean {
  const turn = turns.find(({ id }) => id === trace.turnId);
  return Boolean(
    turn
    && !/^(?:completed|failed|cancelled|interrupted)$/u.test(turn.status)
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

const PROVIDER_LABELS: Partial<Record<SubagentTrace["providerId"], string>> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
};

export function subagentProviderLabel(trace: SubagentTrace): string {
  return PROVIDER_LABELS[trace.providerId] ?? "OpenCode";
}

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  "codex-app-server": "App Server",
  "claude-agent-sdk": "Agent SDK",
  "cursor-acp": "ACP",
  "opencode-sdk": "SDK",
};

export function subagentHarnessLabel(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): string {
  const harnessId = turns.find(({ id }) => id === trace.turnId)?.harnessId;
  if (!harnessId) return "historical harness unavailable";
  if (harnessId.endsWith("-cli")) return "CLI";
  return HARNESS_LABELS[harnessId] ?? harnessId;
}

export function subagentRouteLabel(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): string {
  return `${subagentProviderLabel(trace)} · ${subagentHarnessLabel(trace, turns)}`;
}

function humanizeSubagentIdentifier(value: string): string {
  const words = value.trim().replace(/[_\s-]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function subagentTraceLabel(trace: SubagentTrace): string {
  const name = trace.providerName ?? trace.providerRole;
  if (name) return humanizeSubagentIdentifier(name);
  return `${subagentProviderLabel(trace)} delegated task`;
}

export function subagentRoleLabel(trace: SubagentTrace): string | null {
  const role = trace.providerRole;
  return role && role !== trace.providerName
    ? humanizeSubagentIdentifier(role)
    : null;
}

export function subagentMissionSummary(trace: SubagentTrace): string | null {
  const mission = trace.description?.trim();
  if (!mission) return null;
  return mission.length <= MAX_SUBAGENT_SUMMARY_CHARS
    ? mission
    : `${mission.slice(0, MAX_SUBAGENT_SUMMARY_CHARS - 1).trimEnd()}…`;
}

const EQUIVALENT_PROVIDER_STATUSES: Readonly<
  Record<SubagentTrace["status"], readonly string[]>
> = {
  queued: ["pending", "pendinginit", "queued"],
  spawned: ["spawned", "starting"],
  running: [
    "running",
    "inprogress",
    "started",
    "interacted",
    "asynclaunched",
  ],
  waiting: ["paused", "waiting"],
  completed: ["completed", "success", "succeeded"],
  failed: ["error", "failed"],
  cancelled: ["canceled", "cancelled", "killed", "shutdown", "stopped"],
  interrupted: ["interrupted"],
  lost: ["lost"],
  unknown: [],
};

const STATUS_LABELS: Record<SubagentTrace["status"], string> = {
  queued: "Queued",
  spawned: "Starting",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  lost: "Lost",
  unknown: "Unknown",
};

function normalizedProviderStatus(status: string): string {
  return status.toLowerCase().replaceAll(/[-_\s]/gu, "");
}

export function subagentStatusLabel(trace: SubagentTrace): string {
  const normalized = STATUS_LABELS[trace.status];
  const providerStatus = trace.providerStatus?.trim();
  const providerStatusKey = providerStatus
    ? normalizedProviderStatus(providerStatus)
    : null;
  const contradictsTerminalState = !trace.isLive
    && providerStatusKey
    && providerStatusKey !== "starting"
    && (["queued", "spawned", "running", "waiting"] as const)
      .some((status) => EQUIVALENT_PROVIDER_STATUSES[status].includes(providerStatusKey));
  const repeatsNormalizedState = providerStatusKey
    ? EQUIVALENT_PROVIDER_STATUSES[trace.status].includes(providerStatusKey)
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
  const parent = traces.find(({ id }) => id === trace.parentTraceId);
  if (parent) return `Child of ${subagentTraceLabel(parent)}`;
  if (subagentHasNestedParent(trace)) {
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
