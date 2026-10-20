import type Database from "better-sqlite3";

import type { AgentActivity, AgentPlan, AgentTurn } from "../../shared/contracts";
import { MAX_WATCHER_FEED_PAGE, MAX_WATCHER_PENDING_RUNNING_IDS } from "../../shared/watcher";
import { activityFromRow, agentTurnFromRow, planFromRow } from "./codecs";
import type {
  ConversationContextTurnFile,
  ConversationContextTurnReads,
} from "./conversation-context-turn-reads";
import type { ActivityRow, AgentPlanRow, AgentTurnRow } from "./rows";
import { cachedStatement } from "./statement-cache";

export const MAX_WATCHER_DIGEST_ACTIVITIES = 200;
export const MAX_WATCHER_DIGEST_MESSAGES = 20;
/** Activity details are bounded at the query so a huge tool result never loads whole. */
export const MAX_WATCHER_ACTIVITY_DETAIL_CHARS = 8_192;

/** `(created_at, id)` position after the last activity a watcher already saw. */
export interface WatcherActivityCursor {
  at: string | null;
  id: string | null;
}

export interface WatcherDigestMessage {
  id: string;
  createdAt: string;
  content: string;
  truncated: boolean;
}

export interface WatcherDigestSourceContext {
  database: Database.Database;
  turnReads(): Pick<ConversationContextTurnReads, "messageText" | "files">;
}

const ACTIVITY_COLUMNS = `id, conversation_id, run_id, turn_id, kind, title,
  substr(detail, 1, ${MAX_WATCHER_ACTIVITY_DETAIL_CHARS}) AS detail, status, created_at`;
const USAGE_LIMITED_SQL = "EXISTS (SELECT 1 FROM usage_limited_turns WHERE usage_limited_turns.turn_id = agent_turns.id)";

function boundedLimit(limit: number, maximum: number): number {
  return Number.isSafeInteger(limit) ? Math.min(maximum, Math.max(0, limit)) : 0;
}

/**
 * Read-only, bounded queries the watcher digest is built from. Every query is
 * scoped to one watched conversation and turn and uses existing indexes; none
 * writes, so building a digest never changes the watched chat.
 */
export class WatcherDigestSource {
  constructor(private readonly context: WatcherDigestSourceContext) {}

  turn(conversationId: string, turnId: string): AgentTurn | null {
    const row = cachedStatement(this.context.database, `
      SELECT agent_turns.*, ${USAGE_LIMITED_SQL} AS usage_limited
      FROM agent_turns WHERE id = ? AND conversation_id = ?
    `).get(turnId, conversationId) as (AgentTurnRow & { usage_limited: number }) | undefined;
    return row ? agentTurnFromRow(row) : null;
  }

  latestTurn(conversationId: string): AgentTurn | null {
    const row = cachedStatement(this.context.database, `
      SELECT agent_turns.*, ${USAGE_LIMITED_SQL} AS usage_limited
      FROM agent_turns WHERE conversation_id = ?
      ORDER BY requested_at DESC, id DESC LIMIT 1
    `).get(conversationId) as (AgentTurnRow & { usage_limited: number }) | undefined;
    return row ? agentTurnFromRow(row) : null;
  }

  /** Activities strictly after the cursor, oldest first. */
  activitiesAfter(
    conversationId: string,
    turnId: string,
    cursor: WatcherActivityCursor,
    limit: number,
  ): AgentActivity[] {
    const bounded = boundedLimit(limit, MAX_WATCHER_DIGEST_ACTIVITIES);
    if (bounded === 0) return [];
    const rows = cursor.at === null
      ? cachedStatement(this.context.database, `
          SELECT ${ACTIVITY_COLUMNS} FROM activities
          WHERE conversation_id = ? AND turn_id = ?
          ORDER BY created_at ASC, id ASC LIMIT ?
        `).all(conversationId, turnId, bounded)
      : cachedStatement(this.context.database, `
          SELECT ${ACTIVITY_COLUMNS} FROM activities
          WHERE conversation_id = ? AND turn_id = ?
            AND (created_at > ? OR (created_at = ? AND id > ?))
          ORDER BY created_at ASC, id ASC LIMIT ?
        `).all(conversationId, turnId, cursor.at, cursor.at, cursor.id ?? "", bounded);
    return (rows as ActivityRow[]).map(activityFromRow);
  }

  /** Re-reads activities that were still running at the previous check. */
  activitiesByIds(conversationId: string, ids: readonly string[]): AgentActivity[] {
    const bounded = [...new Set(ids)].slice(0, MAX_WATCHER_PENDING_RUNNING_IDS);
    if (bounded.length === 0) return [];
    return (cachedStatement(this.context.database, `
      SELECT ${ACTIVITY_COLUMNS} FROM activities
      WHERE conversation_id = ? AND id IN (SELECT value FROM json_each(?))
      ORDER BY created_at ASC, id ASC
    `).all(conversationId, JSON.stringify(bounded)) as ActivityRow[]).map(activityFromRow);
  }

  /** Assistant replies in the watched turn created after `after`, oldest first. */
  assistantMessagesAfter(
    conversationId: string,
    turnId: string,
    after: string | null,
    limit: number,
    maximumBytes: number,
  ): WatcherDigestMessage[] {
    const bounded = boundedLimit(limit, MAX_WATCHER_DIGEST_MESSAGES);
    if (bounded === 0) return [];
    const rows = cachedStatement(this.context.database, `
      SELECT id, created_at FROM messages
      WHERE conversation_id = ? AND turn_id = ? AND role = 'assistant'
        AND (? IS NULL OR created_at > ?)
      ORDER BY created_at ASC, id ASC LIMIT ?
    `).all(conversationId, turnId, after, after, bounded) as Array<{ id: string; created_at: string }>;
    const reads = this.context.turnReads();
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      ...reads.messageText(row.id, Math.max(0, Math.trunc(maximumBytes))),
    }));
  }

  /**
   * Settled command activities per turn of one conversation, counted in SQL
   * for the receipts' "ran N read-only commands" line; no details are read.
   */
  settledCommandCounts(conversationId: string, turnIds: readonly string[]): Map<string, number> {
    const bounded = [...new Set(turnIds)].slice(0, MAX_WATCHER_FEED_PAGE);
    if (bounded.length === 0) return new Map();
    const rows = cachedStatement(this.context.database, `
      SELECT turn_id, COUNT(*) AS count FROM activities
      WHERE conversation_id = ? AND turn_id IN (SELECT value FROM json_each(?))
        AND kind = 'command' AND status <> 'running'
      GROUP BY turn_id
    `).all(conversationId, JSON.stringify(bounded)) as Array<{ turn_id: string; count: number }>;
    return new Map(rows.map((row) => [row.turn_id, row.count]));
  }

  plan(conversationId: string, turnId: string): AgentPlan | null {
    const row = cachedStatement(this.context.database, `
      SELECT conversation_id, run_id, turn_id, explanation, steps_json
      FROM agent_plans WHERE conversation_id = ? AND turn_id = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(conversationId, turnId) as AgentPlanRow | undefined;
    return row ? planFromRow(row) : null;
  }

  messageText(messageId: string, maximumBytes: number): { content: string; truncated: boolean } {
    return this.context.turnReads().messageText(messageId, maximumBytes);
  }

  files(turnId: string): ConversationContextTurnFile[] {
    return this.context.turnReads().files(turnId);
  }
}
