import type {
  AgentTurn,
  SubagentTaskUsage,
  SubagentTrace,
  WorkspaceRun,
} from "@shared/contracts";
import { formatCompact } from "../lib/usageFormat";
import {
  isLiveSubagentTrace,
  subagentElapsedMs,
  subagentMissionSummary,
  subagentNeedsReview,
  subagentTraceLabel,
  type SubagentDisclosureRow,
} from "./subagentDisclosure";
import { backgroundCommandIsLive } from "./backgroundTaskRuns";

interface HarnessTaskReporting {
  provider: string;
  agents: "native" | "completion-only" | "none";
  tokens: boolean;
}

const HARNESS_TASK_REPORTING: Readonly<Record<string, HarnessTaskReporting>> = {
  "codex-app-server": { provider: "Codex", agents: "native", tokens: true },
  "claude-agent-sdk": { provider: "Claude", agents: "native", tokens: true },
  "opencode-sdk": { provider: "OpenCode", agents: "native", tokens: true },
  "cursor-acp": { provider: "Cursor", agents: "completion-only", tokens: false },
  "kimi-acp": { provider: "Kimi Code", agents: "none", tokens: false },
  "antigravity-cli": { provider: "Antigravity", agents: "none", tokens: false },
};

const COMMAND_STATUS_LABELS: Record<WorkspaceRun["status"], string> = {
  running: "Running",
  waiting: "Waiting",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const BACKGROUND_TASK_TOKENS_NOTE =
  "Sum of what the providers reported for these agents. This chat's own usage is in Usage.";

const RECOVERED_COMMAND_DETAIL = "Interrupted when the local runtime stopped.";

const MAX_TASK_DEPTH = 8;

export interface BackgroundTaskTokens {
  value: number | null;
  text: string;
  reason: string | null;
}

export interface BackgroundTaskGroups {
  active: SubagentDisclosureRow[];
  finished: SubagentDisclosureRow[];
}

function harnessReporting(harnessId: string | null): HarnessTaskReporting | null {
  return harnessId ? HARNESS_TASK_REPORTING[harnessId] ?? null : null;
}

export function backgroundTaskHarnessId(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): string | null {
  return turns.find(({ id }) => id === trace.turnId)?.harnessId ?? null;
}

export function backgroundTaskTitle(trace: SubagentTrace): string {
  if (trace.providerName || trace.providerRole) return subagentTraceLabel(trace);
  return subagentMissionSummary(trace) ?? subagentTraceLabel(trace);
}

export function backgroundTaskDoingNow(trace: SubagentTrace): string | null {
  return isLiveSubagentTrace(trace)
    ? trace.activity ?? trace.progress
    : trace.result;
}

export function backgroundTaskElapsedMs(trace: SubagentTrace, now: number): number | null {
  if (isLiveSubagentTrace(trace)) return subagentElapsedMs(trace, now);
  if (trace.durationMs !== null) return trace.durationMs;
  return trace.status === "lost" ? null : subagentElapsedMs(trace, now);
}

export function backgroundCommandElapsedMs(run: WorkspaceRun, now: number): number | null {
  const live = backgroundCommandIsLive(run);
  if (!live && run.detail?.endsWith(RECOVERED_COMMAND_DETAIL)) return null;
  const startedAt = Date.parse(run.startedAt);
  const end = live ? now : run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(end)) return null;
  return Math.max(0, end - startedAt);
}

export function backgroundTaskTokens(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): BackgroundTaskTokens {
  const total = trace.usage?.totalTokens ?? null;
  if (total !== null) return { value: total, text: formatCompact(total), reason: null };
  const reporting = harnessReporting(backgroundTaskHarnessId(trace, turns));
  const reason = !reporting
    ? "Not reported"
    : !reporting.tokens
      ? `${reporting.provider} does not report tokens for delegated tasks`
      : isLiveSubagentTrace(trace)
        ? "Not reported yet"
        : "Not reported for this task";
  return { value: null, text: "—", reason };
}

export function backgroundTaskLatestStep(
  usage: SubagentTaskUsage | null,
): string[] | null {
  if (!usage) return null;
  const parts = ([
    ["Input", usage.inputTokens],
    ["Cached", usage.cachedInputTokens],
    ["Cache write", usage.cacheWriteInputTokens],
    ["Output", usage.outputTokens],
    ["Reasoning", usage.reasoningOutputTokens],
  ] as const).flatMap(([label, value]) =>
    value === null ? [] : [`${label} ${formatCompact(value)}`]);
  return parts.length > 0 ? parts : null;
}

export function backgroundTaskContextUsage(
  usage: SubagentTaskUsage | null,
): { remainingPercent: number; label: string } | null {
  if (!usage || usage.contextTokens === null || !usage.maxContextTokens) return null;
  const remaining = Math.min(100, Math.max(0,
    100 - (usage.contextTokens / usage.maxContextTokens) * 100));
  const remainingPercent = Math.round(remaining);
  const percent = remaining > 0 && remaining < 1
    ? "<1"
    : remaining > 99 && remaining < 100
      ? ">99"
      : String(remainingPercent);
  return {
    remainingPercent,
    label: `${percent}% of ${formatCompact(usage.maxContextTokens)} remaining`,
  };
}

export function backgroundTaskSummaryLabel(
  traces: readonly SubagentTrace[],
  commands: readonly WorkspaceRun[],
): string {
  let active = 0;
  let review = 0;
  let finished = 0;
  for (const trace of traces) {
    if (isLiveSubagentTrace(trace)) active += 1;
    else if (subagentNeedsReview(trace)) review += 1;
    else finished += 1;
  }
  for (const run of commands) {
    if (backgroundCommandIsLive(run)) active += 1;
    else if (run.status === "failed") review += 1;
    else finished += 1;
  }
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  if (review > 0) parts.push(`${review} ${review === 1 ? "needs" : "need"} review`);
  if (finished > 0) parts.push(`${finished} finished`);
  return parts.join(" · ");
}

export function backgroundTaskTokenTotalLabel(
  traces: readonly SubagentTrace[],
): string | null {
  let total = 0;
  let reporting = 0;
  for (const trace of traces) {
    const tokens = trace.usage?.totalTokens ?? null;
    if (tokens === null) continue;
    total += tokens;
    reporting += 1;
  }
  if (reporting === 0) return null;
  const label = `${formatCompact(total)} tokens reported`;
  return reporting === traces.length
    ? label
    : `${label} by ${reporting} of ${traces.length} agents`;
}

function rowsWithin(
  rows: readonly SubagentDisclosureRow[],
  include: (trace: SubagentTrace) => boolean,
): SubagentDisclosureRow[] {
  const byId = new Map(rows.map((row) => [row.trace.id, row]));
  const included = rows.filter(({ trace }) => include(trace));
  const includedIds = new Set(included.map(({ trace }) => trace.id));
  const depths = new Map<string, number>();
  return included.map((row) => {
    let parentId = row.trace.parentTraceId;
    const seen = new Set<string>();
    while (parentId && !includedIds.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      parentId = byId.get(parentId)?.trace.parentTraceId ?? null;
    }
    const parentDepth = parentId ? depths.get(parentId) : undefined;
    const depth = parentDepth === undefined
      ? 0
      : Math.min(parentDepth + 1, MAX_TASK_DEPTH);
    depths.set(row.trace.id, depth);
    return { ...row, depth };
  });
}

export function backgroundTaskGroups(
  rows: readonly SubagentDisclosureRow[],
): BackgroundTaskGroups {
  return {
    active: [
      ...rowsWithin(rows, isLiveSubagentTrace),
      ...rowsWithin(rows, subagentNeedsReview),
    ],
    finished: rowsWithin(rows, (trace) =>
      !isLiveSubagentTrace(trace) && !subagentNeedsReview(trace)),
  };
}

export function orderedBackgroundCommands(
  commands: readonly WorkspaceRun[],
): WorkspaceRun[] {
  return [...commands].sort((left, right) =>
    Number(backgroundCommandIsLive(right)) - Number(backgroundCommandIsLive(left))
    || right.startedAt.localeCompare(left.startedAt, "en")
    || right.id.localeCompare(left.id, "en"));
}

export function backgroundCommandStatusLabel(status: WorkspaceRun["status"]): string {
  return COMMAND_STATUS_LABELS[status];
}

export function backgroundTaskEmptyNote(harnessId: string | null): string | null {
  const reporting = harnessReporting(harnessId);
  if (reporting?.agents === "none") {
    return `${reporting.provider} does not report delegated agents. Commands it starts appear here.`;
  }
  if (reporting?.agents === "completion-only") {
    return `${reporting.provider} reports a delegated task when it finishes.`;
  }
  return null;
}
