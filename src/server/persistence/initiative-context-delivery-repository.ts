import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { PROVIDER_CONTEXT_COMPACTION_ACTIVITY_TITLES } from "../provider/context-compaction-activity";

/**
 * What a provider session holds of a chat's initiative after a turn. A part
 * is null when the session has no copy of it: never sent, sent while empty,
 * or announced as cleared. A null `initiativeName` records that the session
 * was told the chat left its initiative; a null `initiativeId` with a name
 * means that initiative has since been deleted.
 */
export interface InitiativeContextDeliveryState {
  initiativeId: string | null;
  initiativeName: string | null;
  briefRevision: number | null;
  notesRevision: number | null;
  /** SHA-256 of the notes index text the session holds, so an unchanged index is not re-sent. */
  notesDigest: string | null;
}

/** The newest delivery that reached a provider session, with the turn that carried it. */
export interface InitiativeContextDelivery extends InitiativeContextDeliveryState {
  turnId: string;
  deliveredAt: string;
}

interface DeliveryRow {
  initiative_id: string | null;
  initiative_name: string | null;
  turn_id: string;
  brief_revision: number | null;
  notes_revision: number | null;
  notes_digest: string | null;
  delivered_at: string;
}

/**
 * Records what one turn left its provider session holding, replacing an
 * earlier record for the same turn (a turn that restarts on a fresh provider
 * session sends again). The one write path for deliveries; it runs inside the
 * caller's transaction. An initiative deleted meanwhile is recorded by name
 * only: the turn still carried its material, so the next turn says it no
 * longer applies.
 */
export function recordInitiativeContextDelivery(
  database: Database.Database,
  input: InitiativeContextDeliveryState & { conversationId: string; turnId: string; deliveredAt: string },
): void {
  clearInitiativeContextDelivery(database, input.turnId);
  const initiativeExists = input.initiativeId !== null
    && database.prepare("SELECT 1 FROM initiatives WHERE id = ?").get(input.initiativeId) !== undefined;
  database.prepare(`
    INSERT INTO initiative_context_deliveries (
      id, conversation_id, initiative_id, initiative_name, turn_id,
      brief_revision, notes_revision, notes_digest, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.conversationId,
    initiativeExists ? input.initiativeId : null,
    input.initiativeName,
    input.turnId,
    input.briefRevision,
    input.notesRevision,
    input.notesDigest,
    input.deliveredAt,
  );
}

/** Forgets a turn's delivery, for a turn whose request carried none or never reached its provider. */
export function clearInitiativeContextDelivery(database: Database.Database, turnId: string): void {
  database.prepare("DELETE FROM initiative_context_deliveries WHERE turn_id = ?").run(turnId);
}

const COMPACTION_TITLES_JSON = JSON.stringify(PROVIDER_CONTEXT_COMPACTION_ACTIVITY_TITLES);

export class InitiativeContextDeliveryRepository {
  constructor(private readonly database: Database.Database) {}

  /**
   * The newest delivery to this chat that reached its provider. A turn counts
   * once it started and did not fail to start, the same rule `@chat` packets
   * use for turns that never reached the provider, so a lost send is repeated.
   *
   * With `providerSessionId`, only deliveries made in that provider session
   * count: a resumed session remembers only what it was itself sent, so a
   * session that began without the brief (for example while the initiative
   * was archived) still receives it once.
   *
   * Compaction drops shared material from a session's context, so deliveries
   * from turns requested before the chat's newest compaction do not count:
   * a manual `/compact` (its receipt) or a compaction the provider recorded
   * while running a turn (its activity).
   */
  latestDelivered(
    conversationId: string,
    { providerSessionId }: { providerSessionId?: string | null } = {},
  ): InitiativeContextDelivery | null {
    const row = this.database.prepare(`
      WITH compaction(at) AS (
        SELECT MAX(at) FROM (
          SELECT MAX(created_at) AS at FROM messages
          WHERE conversation_id = @conversationId AND compaction_json IS NOT NULL
          UNION ALL
          SELECT MAX(created_at) AS at FROM activities
          WHERE conversation_id = @conversationId
            AND title IN (SELECT value FROM json_each(@compactionTitles))
        )
      )
      SELECT delivery.initiative_id, delivery.initiative_name, delivery.turn_id,
        delivery.brief_revision, delivery.notes_revision, delivery.notes_digest,
        delivery.delivered_at
      FROM initiative_context_deliveries AS delivery
      JOIN agent_turns AS turn
        ON turn.id = delivery.turn_id AND turn.conversation_id = delivery.conversation_id
      WHERE delivery.conversation_id = @conversationId
        AND turn.started_at IS NOT NULL
        AND COALESCE(turn.terminal_reason, '') <> 'turn-start-failed'
        AND (
          @providerSessionId IS NULL
          OR turn.provider_session_before = @providerSessionId
          OR turn.provider_session_after = @providerSessionId
        )
        AND turn.requested_at > COALESCE((SELECT at FROM compaction), '')
      ORDER BY turn.requested_at DESC, turn.id DESC
      LIMIT 1
    `).get({
      conversationId,
      providerSessionId: providerSessionId ?? null,
      compactionTitles: COMPACTION_TITLES_JSON,
    }) as DeliveryRow | undefined;
    return row
      ? {
          initiativeId: row.initiative_id,
          initiativeName: row.initiative_name,
          turnId: row.turn_id,
          briefRevision: row.brief_revision,
          notesRevision: row.notes_revision,
          notesDigest: row.notes_digest,
          deliveredAt: row.delivered_at,
        }
      : null;
  }
}
