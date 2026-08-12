import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { AgentTurnRow } from "./rows";
import {
  compactMessageContentForTurn,
  compactReasoningContentForTurn,
} from "./stream-text-storage";

export class RecoveryRepository {
  constructor(private readonly database: Database.Database) {}

  recoverInterruptedRuns(): void {
    const interrupted = this.database.prepare(`
      SELECT DISTINCT conversations.id
      FROM conversations
      LEFT JOIN agent_turns ON agent_turns.conversation_id = conversations.id
      WHERE (
        conversations.status IN ('running', 'needs-input')
        OR agent_turns.status IN (
           'queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input'
         )
      )
        AND NOT EXISTS (
          SELECT 1 FROM provider_run_ownership AS cleanup
          WHERE cleanup.turn_id = agent_turns.id
             OR cleanup.conversation_id = conversations.id
        )
    `).all() as Array<{ id: string }>;
    const interruptedRunByConversation = new Map(
      (this.database.prepare(`
        SELECT conversation_id, id
        FROM workspace_runs
        WHERE kind = 'agent'
          AND conversation_id IS NOT NULL
          AND status IN ('running', 'waiting')
          AND id NOT IN (SELECT run_id FROM provider_run_ownership)
        ORDER BY started_at ASC, id ASC
      `).all() as Array<{ conversation_id: string; id: string }>)
        .map(({ conversation_id, id }) => [conversation_id, id] as const),
    );
    const wallClockNow = new Date().toISOString();
    const latestTurnTimestamp = (this.database.prepare(`
      SELECT MAX(updated_at) AS timestamp
      FROM agent_turns
      WHERE status IN (
        'queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input'
      )
    `).get() as { timestamp: string | null }).timestamp;
    const now = latestTurnTimestamp && latestTurnTimestamp > wallClockNow
      ? latestTurnTimestamp
      : wallClockNow;
    const markWorkspaceRuns = this.database.prepare(`
      UPDATE workspace_runs
      SET status = 'failed',
          attention_state = 'unseen',
          detail = substr(
            CASE
              WHEN detail IS NULL OR detail = '' THEN 'Interrupted when the local runtime stopped.'
              ELSE detail || ' · Interrupted when the local runtime stopped.'
            END,
            1,
            1000
          ),
          finished_at = ?
      WHERE status IN ('running', 'waiting')
        AND id NOT IN (SELECT run_id FROM provider_run_ownership)
    `);
    const markSubagents = this.database.prepare(`
      UPDATE subagent_traces
      SET status = 'lost',
          is_live = 0,
          sequence = sequence + 1,
          updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE is_live = 1
        AND turn_id IN (
          SELECT id FROM agent_turns
          WHERE status IN (
            'queued', 'starting', 'running',
            'waiting-for-approval', 'waiting-for-input'
          )
            AND id NOT IN (SELECT turn_id FROM provider_run_ownership)
        )
    `);

    const markConversation = this.database.prepare(
      "UPDATE conversations SET status = 'failed', attention_kind = NULL, updated_at = ? WHERE id = ?",
    );
    const markTurnActivities = this.database.prepare(
      "UPDATE activities SET status = 'failed' WHERE conversation_id = ? AND turn_id = ? AND status = 'running'",
    );
    const markTurnReasonings = this.database.prepare(
      "UPDATE agent_reasonings SET status = 'failed' WHERE conversation_id = ? AND turn_id = ? AND status = 'running'",
    );
    const markLegacyActivities = this.database.prepare(
      "UPDATE activities SET status = 'failed' WHERE conversation_id = ? AND turn_id IS NULL AND status = 'running'",
    );
    const markLegacyReasonings = this.database.prepare(
      "UPDATE agent_reasonings SET status = 'failed' WHERE conversation_id = ? AND turn_id IS NULL AND status = 'running'",
    );
    const markInterruptedTurn = this.database.prepare(`
      UPDATE agent_turns
      SET status = 'interrupted',
          started_at = COALESCE(started_at, requested_at),
          completed_at = ?,
          terminal_reason = COALESCE(terminal_reason, 'runtime-restart'),
          updated_at = ?
      WHERE id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND id NOT IN (SELECT turn_id FROM provider_run_ownership)
    `);
    const addRecoveryActivity = this.database.prepare(`
      INSERT INTO activities (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at)
      VALUES (?, ?, ?, ?, 'error', ?, NULL, 'failed', ?)
    `);
    const explicitTurnForRun = this.database.prepare(`
      SELECT id, conversation_id, run_id
      FROM agent_turns
      WHERE conversation_id = ?
        AND run_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND id NOT IN (SELECT turn_id FROM provider_run_ownership)
      LIMIT 1
    `);
    const latestExplicitTurn = this.database.prepare(`
      SELECT id, conversation_id, run_id
      FROM agent_turns
      WHERE conversation_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND id NOT IN (SELECT turn_id FROM provider_run_ownership)
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `);
    this.database.transaction(() => {
      markWorkspaceRuns.run(now);
      markSubagents.run(now, now);
      for (const { id } of interrupted) {
        markConversation.run(now, id);
        const interruptedRunId = interruptedRunByConversation.get(id);
        const turn = (
          (interruptedRunId
            ? explicitTurnForRun.get(id, interruptedRunId)
            : undefined) as Pick<
              AgentTurnRow,
              "id" | "conversation_id" | "run_id"
            > | undefined
        ) ?? (
          latestExplicitTurn.get(id) as Pick<
            AgentTurnRow,
            "id" | "conversation_id" | "run_id"
          > | undefined
        );
        if (turn) {
          markTurnActivities.run(id, turn.id);
          markTurnReasonings.run(id, turn.id);
          markInterruptedTurn.run(now, now, turn.id);
          compactMessageContentForTurn(this.database, turn.id);
          compactReasoningContentForTurn(this.database, turn.id);
        } else {
          // Preserve recovery for databases that predate authoritative turn ownership.
          markLegacyActivities.run(id);
          markLegacyReasonings.run(id);
        }
        addRecoveryActivity.run(
          randomUUID(),
          id,
          turn?.run_id ?? `recovery-${randomUUID()}`,
          turn?.id ?? null,
          "The previous run ended when Inertia closed. Send another message to continue.",
          now,
        );
      }
    })();
  }
}
