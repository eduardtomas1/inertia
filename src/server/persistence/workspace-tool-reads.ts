import type Database from "better-sqlite3";

import type { AgentPlan, WorkspaceRun } from "../../shared/contracts";
import { workspaceRunFromRow } from "./codecs";
import { withLatestPlanDocument } from "./latest-plan-document";
import type { WorkspaceRunRow } from "./rows";
import { cachedStatement } from "./statement-cache";

const MAX_ACTIVE_ACTION_RUNS = 200;

/**
 * Narrow, read-only queries behind the agent-facing `inertia.workspace`
 * tools. Each reads the same rows the matching user surface projects, without
 * loading a whole conversation detail.
 */
export class WorkspaceToolReads {
  constructor(private readonly database: Database.Database) {}

  /**
   * The rows the Plan tab uses for the chat's latest plan: the newest plan
   * last, preceded by the latest documented plan when that is a different
   * run of the same uninterrupted planning stretch.
   */
  latestPlans(conversationId: string): AgentPlan[] {
    return withLatestPlanDocument(this.database, conversationId, []);
  }

  /** File-scope review marks of one repository in the chat's Changes view. */
  fileReviewStates(
    conversationId: string,
    repositoryPath = ".",
  ): Map<string, { reviewed: boolean; stale: boolean }> {
    const rows = cachedStatement(this.database, `
      SELECT path, reviewed, stale FROM diff_review_states
      WHERE conversation_id = ? AND COALESCE(NULLIF(repository_path, ''), '.') = ?
        AND scope = 'file'
    `).all(conversationId, repositoryPath) as Array<{ path: string; reviewed: 0 | 1; stale: 0 | 1 }>;
    return new Map(rows.map((row) => [row.path, {
      reviewed: row.reviewed === 1,
      stale: row.stale === 1,
    }]));
  }

  /** Recorded project Run actions that have not finished. */
  activeProjectActionRuns(projectId: string): WorkspaceRun[] {
    return (cachedStatement(this.database, `
      SELECT * FROM workspace_runs
      WHERE project_id = ? AND action_id IS NOT NULL
        AND status IN ('running', 'waiting')
      ORDER BY started_at DESC, id DESC
      LIMIT ${MAX_ACTIVE_ACTION_RUNS}
    `).all(projectId) as WorkspaceRunRow[]).map(workspaceRunFromRow);
  }
}
