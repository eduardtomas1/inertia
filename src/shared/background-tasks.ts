import { z } from "zod";

import type { SubagentTrace } from "./contracts/agent";
import type { WorkspaceRun } from "./contracts/app";
import { subagentTrace } from "./contracts/subagent-trace-schema";

export const BACKGROUND_TASK_PAGE_SIZE = 20;
export const MAX_LIVE_BACKGROUND_TASKS = 64;
const MAX_CURSOR_KEY_LENGTH = 260;

export const backgroundTaskCursorSchema = z.strictObject({
  startedAt: z.string().min(1).max(64),
  key: z.string().regex(/^(?:agent|command):/u).max(MAX_CURSOR_KEY_LENGTH),
});

export type BackgroundTaskCursor = z.infer<typeof backgroundTaskCursorSchema>;

export interface BackgroundTasksResult {
  kind: "conversation.background-tasks";
  conversationId: string;
  subagents: SubagentTrace[];
  runs: WorkspaceRun[];
  finishedCount: number;
  failedCount: number;
  next: BackgroundTaskCursor | null;
}

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
