import type {
  AgentTurn,
  SubagentTaskUsage,
  SubagentTrace,
  WorkspaceRun,
} from "@shared/contracts";
import { formatCompact } from "../lib/compactFormat";
import {
  isLiveSubagentTrace,
  subagentElapsedMs,
  subagentMissionSummary,
  subagentTraceLabel,
} from "./subagentDisclosure";
import { backgroundCommandIsLive } from "./backgroundTaskRuns";

const PROVIDERS_WITHOUT_TASK_TOKENS: Readonly<Record<string, string>> = {
  "cursor-acp": "Cursor",
  "kimi-acp": "Kimi Code",
  "antigravity-cli": "Antigravity",
};

const RECOVERED_COMMAND_DETAIL = "Interrupted when the local runtime stopped.";

export interface BackgroundTaskStateWord {
  word: string;
  danger: boolean;
}

const TASK_STATE_WORDS: Partial<Record<SubagentTrace["status"], BackgroundTaskStateWord>> = {
  queued: { word: "Queued", danger: false },
  spawned: { word: "Starting", danger: false },
  waiting: { word: "Waiting", danger: false },
  failed: { word: "Failed", danger: true },
  cancelled: { word: "Stopped", danger: false },
  interrupted: { word: "Interrupted", danger: true },
  lost: { word: "Lost", danger: true },
  unknown: { word: "Unknown", danger: false },
};

const COMMAND_STATE_WORDS: Partial<Record<WorkspaceRun["status"], BackgroundTaskStateWord>> = {
  waiting: { word: "Waiting", danger: false },
  failed: { word: "Failed", danger: true },
  cancelled: { word: "Stopped", danger: false },
};

export type BackgroundTaskItem =
  | { type: "agent"; key: string; startedAt: string; trace: SubagentTrace }
  | { type: "command"; key: string; startedAt: string; run: WorkspaceRun };

export interface BackgroundTaskItems {
  active: BackgroundTaskItem[];
  finished: BackgroundTaskItem[];
  failed: number;
}

function compareItems(left: BackgroundTaskItem, right: BackgroundTaskItem): number {
  return left.startedAt.localeCompare(right.startedAt, "en")
    || left.key.localeCompare(right.key, "en");
}

export function backgroundTaskItems(
  subagents: readonly SubagentTrace[],
  commands: readonly WorkspaceRun[],
): BackgroundTaskItems {
  const active: BackgroundTaskItem[] = [];
  const finished: BackgroundTaskItem[] = [];
  let failed = 0;
  for (const trace of subagents) {
    const item = { type: "agent", key: `agent:${trace.id}`, startedAt: trace.createdAt, trace } as const;
    if (isLiveSubagentTrace(trace)) active.push(item);
    else {
      finished.push(item);
      if (backgroundTaskStateWord(trace)?.danger) failed += 1;
    }
  }
  for (const run of commands) {
    const item = { type: "command", key: `command:${run.id}`, startedAt: run.startedAt, run } as const;
    if (backgroundCommandIsLive(run)) active.push(item);
    else {
      finished.push(item);
      if (run.status === "failed") failed += 1;
    }
  }
  return {
    active: active.sort(compareItems),
    finished: finished.sort((left, right) => compareItems(right, left)),
    failed,
  };
}

export function backgroundTaskStateWord(trace: SubagentTrace): BackgroundTaskStateWord | null {
  return TASK_STATE_WORDS[trace.status] ?? null;
}

export function backgroundCommandStateWord(run: WorkspaceRun): BackgroundTaskStateWord | null {
  return COMMAND_STATE_WORDS[run.status] ?? null;
}

export function backgroundTaskTokensNotReported(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): string | null {
  if (trace.usage?.totalTokens != null) return null;
  const harnessId = turns.find(({ id }) => id === trace.turnId)?.harnessId;
  const provider = harnessId ? PROVIDERS_WITHOUT_TASK_TOKENS[harnessId] : undefined;
  return provider ? `Tokens not reported by ${provider}` : null;
}

export function backgroundTaskTitle(trace: SubagentTrace): string {
  if (trace.providerName || trace.providerRole) return subagentTraceLabel(trace);
  return subagentMissionSummary(trace) ?? subagentTraceLabel(trace);
}

export function backgroundTaskCurrentActivity(trace: SubagentTrace): string | null {
  return isLiveSubagentTrace(trace) && (trace.status === "running" || trace.status === "spawned")
    ? trace.activity
    : null;
}

export function backgroundTaskDoingNow(trace: SubagentTrace): string | null {
  if (!isLiveSubagentTrace(trace)) return trace.result;
  const activity = backgroundTaskCurrentActivity(trace);
  // A bare tool name such as "Bash" says less than the provider's own
  // progress sentence, so the sentence wins; a descriptive activity stays.
  if (activity && trace.progress && !/\s/u.test(activity.trim())) return trace.progress;
  return activity ?? trace.progress;
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

export function backgroundTaskContextLeft(usage: SubagentTaskUsage | null): string | null {
  if (!usage || usage.contextTokens === null || !usage.maxContextTokens) return null;
  const remaining = Math.min(100, Math.max(0,
    100 - (usage.contextTokens / usage.maxContextTokens) * 100));
  const percent = remaining > 0 && remaining < 1
    ? "<1"
    : remaining > 99 && remaining < 100
      ? ">99"
      : String(Math.round(remaining));
  return `${percent}% context left`;
}

export function backgroundTaskTranscriptMeta(
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): string | null {
  const notReported = backgroundTaskTokensNotReported(trace, turns);
  if (notReported) return notReported;
  const context = backgroundTaskContextLeft(trace.usage);
  const parts = [...backgroundTaskLatestStep(trace.usage) ?? [], ...context ? [context] : []];
  return parts.length > 0 ? parts.join(" · ") : null;
}
