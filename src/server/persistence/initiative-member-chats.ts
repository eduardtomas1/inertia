import type Database from "better-sqlite3";

import type { ConversationShell, WorkspaceRun } from "../../shared/contracts";
import { agentTurnFromRow, conversationShellFromRow, workspaceRunFromRow } from "./codecs";
import { CONVERSATION_HAS_HISTORY_SQL } from "./conversation-provider-policy";
import type { AgentTurnRow, ConversationRow, WorkspaceRunRow } from "./rows";
import { cachedStatement } from "./statement-cache";

/** Whether a turn stopped at a usage limit, as the Work status reports it. */
export const TURN_USAGE_LIMITED_SQL = "EXISTS (SELECT 1 FROM usage_limited_turns WHERE usage_limited_turns.turn_id = agent_turns.id)";

export interface InitiativeMemberChat {
  conversation: ConversationShell;
  /** The canonical agent run that decides the chat's Work status, if any. */
  run: WorkspaceRun | null;
}

/**
 * An initiative's chats that are not archived, read directly rather than
 * through an app snapshot: at most `limit`, `first` leading when it is one of
 * them, then the others most recently updated first. Each comes with its
 * canonical agent run, chosen as the sidebar chooses it (a live or waiting run
 * over settled ones, then the newest). `total` counts every such chat.
 */
export function initiativeMemberChats(
  database: Database.Database,
  initiativeId: string,
  { first, limit }: { first: string | null; limit: number },
): { chats: InitiativeMemberChat[]; total: number } {
  const rows = cachedStatement(database, `
    SELECT conversations.*, ${CONVERSATION_HAS_HISTORY_SQL} AS has_history
    FROM conversations
    WHERE initiative_id = @initiativeId AND archived_at IS NULL
    ORDER BY (id = @first) DESC, updated_at DESC, id ASC
    LIMIT @limit
  `).all({ initiativeId, first: first ?? "", limit }) as Array<ConversationRow & { has_history: number }>;
  const { total } = cachedStatement(database, `
    SELECT COUNT(*) AS total FROM conversations
    WHERE initiative_id = ? AND archived_at IS NULL
  `).get(initiativeId) as { total: number };
  const latestTurn = cachedStatement(database, `
    SELECT agent_turns.*, ${TURN_USAGE_LIMITED_SQL} AS usage_limited FROM agent_turns
    WHERE conversation_id = ?
    ORDER BY requested_at DESC, id DESC
    LIMIT 1
  `);
  const canonicalRun = cachedStatement(database, `
    SELECT * FROM workspace_runs
    WHERE conversation_id = ? AND kind = 'agent'
    ORDER BY status IN ('running', 'waiting') DESC, started_at DESC, id DESC
    LIMIT 1
  `);
  const chats = rows.map((row) => {
    const turn = latestTurn.get(row.id) as (AgentTurnRow & { usage_limited: number }) | undefined;
    const run = canonicalRun.get(row.id) as WorkspaceRunRow | undefined;
    return {
      conversation: conversationShellFromRow(row, turn ? agentTurnFromRow(turn) : null, turn?.usage_limited === 1),
      run: run ? workspaceRunFromRow(run) : null,
    };
  });
  return { chats, total };
}
