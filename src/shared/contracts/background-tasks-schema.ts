import type { SubagentTrace } from "./agent";
import type { WorkspaceRun } from "./app";
import { subagentTrace } from "./subagent-trace-schema";
import {
  BACKGROUND_TASK_PAGE_SIZE,
  MAX_LIVE_BACKGROUND_TASKS,
  backgroundTaskCursorSchema,
} from "../background-tasks";

function count(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function backgroundTasksResult(
  value: Record<string, unknown>,
  workspaceRun: (run: unknown) => boolean,
): boolean {
  const { subagents, runs } = value;
  return typeof value.conversationId === "string"
    && Array.isArray(subagents)
    && subagents.length <= MAX_LIVE_BACKGROUND_TASKS + BACKGROUND_TASK_PAGE_SIZE
    && subagents.every((trace) => subagentTrace(trace)
      && (trace as SubagentTrace).conversationId === value.conversationId)
    && Array.isArray(runs)
    && runs.length <= MAX_LIVE_BACKGROUND_TASKS + BACKGROUND_TASK_PAGE_SIZE
    && runs.every((run) => workspaceRun(run)
      && (run as WorkspaceRun).conversationId === value.conversationId)
    && count(value.finishedCount)
    && count(value.failedCount)
    && (value.failedCount as number) <= (value.finishedCount as number)
    && (value.next === null || backgroundTaskCursorSchema.safeParse(value.next).success);
}
