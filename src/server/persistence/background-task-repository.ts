import type Database from "better-sqlite3";

import {
  BACKGROUND_TASK_PAGE_SIZE,
  MAX_LIVE_BACKGROUND_TASKS,
  type BackgroundTaskCursor,
  type BackgroundTasksResult,
} from "../../shared/background-tasks";
import { subagentTraceFromRow, workspaceRunFromRow } from "./codecs";
import type { SubagentTraceRow, WorkspaceRunRow } from "./rows";

const COMMAND_RUN = `workspace_runs.conversation_id = @conversationId
  AND CASE WHEN workspace_runs.kind = 'agent'
    THEN NOT EXISTS (SELECT 1 FROM agent_turns WHERE agent_turns.run_id = workspace_runs.id)
      AND (workspace_runs.status IN ('running', 'waiting')
        OR workspace_runs.started_at >= (
          SELECT MIN(agent_turns.requested_at) FROM agent_turns
          WHERE agent_turns.conversation_id = @conversationId))
    ELSE workspace_runs.kind = 'source-control' OR workspace_runs.action_id IS NOT NULL
  END`;

const FINISHED = `
  SELECT 'agent' AS type, id, created_at AS started_at, 'agent:' || id AS sort_key,
    status IN ('failed', 'interrupted', 'lost') AS failed
  FROM subagent_traces
  WHERE conversation_id = @conversationId AND is_live = 0
  UNION ALL
  SELECT 'command' AS type, id, started_at, 'command:' || id AS sort_key, status = 'failed' AS failed
  FROM workspace_runs
  WHERE ${COMMAND_RUN}
    AND status NOT IN ('running', 'waiting')
    AND attention_state <> 'dismissed'`;

interface FinishedRow {
  type: "agent" | "command";
  id: string;
  started_at: string;
  sort_key: string;
}

export function backgroundTasks(
  database: Database.Database,
  conversationId: string,
  before: BackgroundTaskCursor | null,
): BackgroundTasksResult {
  const parameters = {
    conversationId,
    beforeAt: before?.startedAt ?? null,
    beforeKey: before?.key ?? null,
    limit: BACKGROUND_TASK_PAGE_SIZE + 1,
  };
  return database.transaction((): BackgroundTasksResult => {
    const totals = database.prepare(`
      SELECT COUNT(*) AS finished, COALESCE(SUM(failed), 0) AS failed FROM (${FINISHED})
    `).get({ conversationId }) as { finished: number; failed: number };
    const page = database.prepare(`
      SELECT type, id, started_at, sort_key FROM (${FINISHED})
      WHERE @beforeAt IS NULL OR started_at < @beforeAt
        OR (started_at = @beforeAt AND sort_key < @beforeKey)
      ORDER BY started_at DESC, sort_key DESC
      LIMIT @limit
    `).all(parameters) as FinishedRow[];
    const shown = page.slice(0, BACKGROUND_TASK_PAGE_SIZE);
    const ids = (type: FinishedRow["type"]) => JSON.stringify(
      shown.filter((row) => row.type === type).map(({ id }) => id),
    );
    const traces = database.prepare(`
      SELECT * FROM subagent_traces
      WHERE conversation_id = @conversationId
        AND (id IN (SELECT value FROM json_each(@ids))
          OR id IN (SELECT id FROM subagent_traces
            WHERE conversation_id = @conversationId AND is_live = 1
            ORDER BY created_at ASC, sequence ASC, id ASC LIMIT @liveLimit))
    `).all({ conversationId, ids: ids("agent"), liveLimit: MAX_LIVE_BACKGROUND_TASKS }) as SubagentTraceRow[];
    const runs = database.prepare(`
      SELECT * FROM workspace_runs
      WHERE id IN (SELECT value FROM json_each(@ids))
        OR id IN (SELECT id FROM workspace_runs
          WHERE ${COMMAND_RUN} AND status IN ('running', 'waiting')
          ORDER BY started_at DESC LIMIT @liveLimit)
    `).all({ conversationId, ids: ids("command"), liveLimit: MAX_LIVE_BACKGROUND_TASKS }) as WorkspaceRunRow[];
    const last = shown.at(-1);
    return {
      kind: "conversation.background-tasks",
      conversationId,
      subagents: traces.map(subagentTraceFromRow),
      runs: runs.map(workspaceRunFromRow),
      finishedCount: totals.finished,
      failedCount: totals.failed,
      next: page.length > BACKGROUND_TASK_PAGE_SIZE && last
        ? { startedAt: last.started_at, key: last.sort_key }
        : null,
    };
  })();
}
