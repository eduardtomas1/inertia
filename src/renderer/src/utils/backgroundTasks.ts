import type {
  AgentTurn,
  SubagentTaskUsage,
  SubagentTrace,
  WorkspaceRun,
} from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";
import { formatCompact } from "../lib/usageFormat";
import {
  isLiveSubagentTrace,
  subagentElapsedMs,
  subagentMissionSummary,
  subagentNeedsReview,
  subagentTraceLabel,
  type SubagentDisclosureRow,
} from "./subagentDisclosure";
import { workspaceRunIsLive } from "./workspaceRuns";

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

export const BACKGROUND_TASK_TOKENS_NOTE =
  "Sum of the tokens providers reported for the tasks below. The chat's own usage is in Usage.";

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

export function backgroundTaskElapsedMs(trace: SubagentTrace, now: number): number {
  return !isLiveSubagentTrace(trace) && trace.durationMs !== null
    ? trace.durationMs
    : subagentElapsedMs(trace, now);
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
): string | null {
  if (!usage) return null;
  const parts = ([
    ["Input", usage.inputTokens],
    ["Cached", usage.cachedInputTokens],
    ["Cache write", usage.cacheWriteInputTokens],
    ["Output", usage.outputTokens],
    ["Reasoning", usage.reasoningOutputTokens],
  ] as const).flatMap(([label, value]) =>
    value === null ? [] : [`${label} ${formatCompact(value)}`]);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function backgroundTaskContextUsage(
  usage: SubagentTaskUsage | null,
): { percent: number; label: string } | null {
  if (!usage || usage.contextTokens === null || !usage.maxContextTokens) return null;
  const percent = Math.min(100, Math.max(0, Math.round(
    (usage.contextTokens / usage.maxContextTokens) * 100,
  )));
  return {
    percent,
    label: `${percent}% of ${formatCompact(usage.maxContextTokens)} used`,
  };
}

export function backgroundTaskSummaryLabel(
  traces: readonly SubagentTrace[],
  commands: readonly WorkspaceRun[],
): string {
  let running = 0;
  let review = 0;
  let finished = 0;
  for (const trace of traces) {
    if (isLiveSubagentTrace(trace)) running += 1;
    else if (subagentNeedsReview(trace)) review += 1;
    else finished += 1;
  }
  for (const run of commands) {
    if (workspaceRunIsLive(run)) running += 1;
    else if (workspaceRunAttentionView(run).reason === "failure") review += 1;
    else finished += 1;
  }
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
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
    : `${label} by ${reporting} of ${traces.length} tasks`;
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
