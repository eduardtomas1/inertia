import type { Query } from "@anthropic-ai/claude-agent-sdk";

import { sanitizeProviderFailureSummary } from "./activity-detail";
import type { SubagentBackgroundResult, SubagentStopOutcome } from "./agent-harness";
import type { ClaudeSubagentTraceTracker } from "./claude-subagent-trace";

const BACKGROUND_FALLBACK = "Claude could not move this agent to the background.";
const BACKGROUND_DECLINED = "Claude declined to move this agent to the background.";
const BACKGROUND_TIMED_OUT = "Claude did not confirm the move to the background in time. The agent may still move there.";
/** Moving an agent waits on Claude's own turn loop, so it gets longer than a Stop. */
export const CLAUDE_BACKGROUND_TASK_TIMEOUT_MS = 10_000;

export interface ClaudeTaskControlOptions {
  query: () => Query | undefined;
  cancelled: () => boolean;
  tracker: ClaudeSubagentTraceTracker;
  timeoutMs: number;
  /** May shorten, never extend, the bound on moving an agent to the background. */
  backgroundTimeoutMs?: number;
}

const TIMED_OUT = Symbol("timed out");

/**
 * Per-task controls over Claude's live query: stop one task, move one
 * foreground agent to the background, and send Stops that were requested
 * before Claude had issued the task id. Every SDK call is time-bounded.
 */
export function createClaudeTaskControls(options: ClaudeTaskControlOptions) {
  const backgroundTimeoutMs = Math.min(
    options.backgroundTimeoutMs ?? CLAUDE_BACKGROUND_TASK_TIMEOUT_MS,
    CLAUDE_BACKGROUND_TASK_TIMEOUT_MS,
  );

  async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        timer.unref();
      });
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function stopTask(query: Query, taskId: string): Promise<boolean> {
    const stopped = await bounded(query.stopTask(taskId).then(() => true, () => false), options.timeoutMs);
    return stopped === true;
  }

  return {
    async stop(providerTaskId: string | null, providerToolUseId?: string | null): Promise<SubagentStopOutcome> {
      const query = options.query();
      if (!query || options.cancelled()) return false;
      const taskId = providerTaskId && options.tracker.isLiveTask(providerTaskId)
        ? providerTaskId
        : providerToolUseId ? options.tracker.liveTaskForToolUse(providerToolUseId) : null;
      if (taskId) return await stopTask(query, taskId);
      return providerToolUseId && options.tracker.queueStop(providerToolUseId) ? "queued" : false;
    },

    async background(providerToolUseId: string): Promise<SubagentBackgroundResult> {
      const query = options.query();
      if (!query || options.cancelled() || !options.tracker.isForegroundAgent(providerToolUseId)) {
        return { moved: false };
      }
      try {
        const moved = await bounded(query.backgroundTasks(providerToolUseId), backgroundTimeoutMs);
        if (moved === TIMED_OUT) return { moved: false, error: BACKGROUND_TIMED_OUT };
        return moved ? { moved: true } : { moved: false, error: BACKGROUND_DECLINED };
      } catch (error) {
        return {
          moved: false,
          error: sanitizeProviderFailureSummary(
            error instanceof Error ? error.message : error,
            BACKGROUND_FALLBACK,
          ),
        };
      }
    },

    releaseQueuedStops(): void {
      const query = options.query();
      for (const taskId of options.tracker.takeReadyStops()) {
        if (!query || options.cancelled()) continue;
        void stopTask(query, taskId).then((stopped) => {
          options.tracker.settleQueuedStop(taskId, stopped);
        });
      }
    },
  };
}
