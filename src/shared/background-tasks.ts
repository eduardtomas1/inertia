import { z } from "zod";

import type { SubagentTrace } from "./contracts/agent";
import type { WorkspaceRun } from "./contracts/app";

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
