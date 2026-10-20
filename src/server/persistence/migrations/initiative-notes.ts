import type { DatabaseMigrationDefinition } from "./catalog";

/**
 * Initiative notes, per-chat delivery bookkeeping for the shared brief and
 * notes index, the timeline receipt metadata, and the `initiative` execution
 * context kind.
 *
 * The note CHECKs mirror `src/shared/initiatives.ts`: titles count characters
 * like initiative names, bodies count UTF-8 bytes. `notes_revision` moves only
 * when the set or content of accepted notes changes; `brief_updated_at` records
 * the last brief edit.
 *
 * Chat and turn identities are bounded rather than shaped: older databases
 * carry chats and backfilled turns whose ids are not UUIDs.
 *
 * Deliveries reference the turn that carried them and record what that
 * provider session now holds: the initiative and the name it was told, and the
 * brief revision and notes index (revision and digest) it has a copy of, each
 * null when it has none. A row without an initiative name records that the
 * session was told the chat left its initiative. Deleting an initiative keeps
 * its rows with a null initiative, so a session that heard of it is told once
 * that it no longer applies. Only turns the provider actually started count
 * when deciding what to send next, so the runtime joins them with
 * `agent_turns` rather than trusting the row alone.
 *
 * `turn_execution_context_refs.kind` is a CHECK-constrained column, so the
 * table is rebuilt (as schema 35 did) to accept `initiative`. Nothing
 * references it, and the copy preserves every row, ordinal and digest.
 */
export const initiativeNotesMigration: DatabaseMigrationDefinition = {
  name: "PersistInitiativeNotes",
  up: (database) => {
    // Kept inside `up` so the lineage digest covers it. The column guards
    // follow the catalog's convention (as migration 99 does): restoring a
    // backup replays migrations over a schema that may already have them.
    const columns = (table: "initiatives" | "messages") => database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const initiativeColumns = columns("initiatives");
    if (!initiativeColumns.some(({ name }) => name === "notes_revision")) {
      database.exec(`
        ALTER TABLE initiatives ADD COLUMN notes_revision INTEGER NOT NULL DEFAULT 0
          CHECK (notes_revision >= 0);
      `);
    }
    // When the brief last changed, so the page can say so without a rename or
    // colour change moving it.
    if (!initiativeColumns.some(({ name }) => name === "brief_updated_at")) {
      database.exec(`
        ALTER TABLE initiatives ADD COLUMN brief_updated_at TEXT
          CHECK (brief_updated_at IS NULL OR length(brief_updated_at) BETWEEN 20 AND 40);
      `);
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS initiative_notes (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE
          CHECK (length(initiative_id) = 36),
        title TEXT NOT NULL
          CHECK (
            length(title) BETWEEN 1 AND 120
            AND title = trim(title)
            AND instr(title, char(0)) = 0
            AND instr(title, char(9)) = 0
            AND instr(title, char(10)) = 0
            AND instr(title, char(13)) = 0
          ),
        body TEXT NOT NULL DEFAULT ''
          CHECK (length(CAST(body AS BLOB)) <= 2048 AND instr(body, char(0)) = 0),
        provenance TEXT NOT NULL CHECK (provenance IN ('user', 'agent')),
        state TEXT NOT NULL CHECK (state IN ('proposed', 'accepted', 'rejected')),
        source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL
          CHECK (source_conversation_id IS NULL OR length(source_conversation_id) BETWEEN 1 AND 200),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
        updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
      );
      CREATE INDEX IF NOT EXISTS initiative_notes_state_idx
        ON initiative_notes(initiative_id, state);
      CREATE INDEX IF NOT EXISTS initiative_notes_source_idx
        ON initiative_notes(source_conversation_id);
      CREATE TRIGGER IF NOT EXISTS initiative_notes_count_limit
        BEFORE INSERT ON initiative_notes
        WHEN NEW.state IN ('accepted', 'proposed')
          AND (
            SELECT COUNT(*) FROM initiative_notes
            WHERE initiative_id = NEW.initiative_id AND state IN ('accepted', 'proposed')
          ) >= 64
        BEGIN
          SELECT RAISE(ABORT, 'initiative note count limit exceeded');
        END;

      CREATE TABLE IF NOT EXISTS initiative_context_deliveries (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
          CHECK (length(conversation_id) BETWEEN 1 AND 200),
        initiative_id TEXT REFERENCES initiatives(id) ON DELETE SET NULL
          CHECK (initiative_id IS NULL OR length(initiative_id) = 36),
        initiative_name TEXT
          CHECK (initiative_name IS NULL OR length(initiative_name) BETWEEN 1 AND 120),
        turn_id TEXT NOT NULL UNIQUE REFERENCES agent_turns(id) ON DELETE CASCADE
          CHECK (length(turn_id) BETWEEN 1 AND 200),
        brief_revision INTEGER CHECK (brief_revision IS NULL OR brief_revision >= 0),
        notes_revision INTEGER CHECK (notes_revision IS NULL OR notes_revision >= 0),
        notes_digest TEXT CHECK (notes_digest IS NULL OR length(notes_digest) = 64),
        delivered_at TEXT NOT NULL CHECK (length(delivered_at) BETWEEN 20 AND 40),
        CHECK (initiative_id IS NULL OR initiative_name IS NOT NULL),
        CHECK (initiative_name IS NOT NULL OR (
          brief_revision IS NULL AND notes_revision IS NULL AND notes_digest IS NULL
        )),
        CHECK ((notes_revision IS NULL) = (notes_digest IS NULL))
      );
      CREATE INDEX IF NOT EXISTS initiative_context_deliveries_conversation_idx
        ON initiative_context_deliveries(conversation_id, delivered_at);
      CREATE INDEX IF NOT EXISTS initiative_context_deliveries_initiative_idx
        ON initiative_context_deliveries(initiative_id);
    `);

    // The receipt rides on a system message, like compaction receipts. The
    // CHECK does not require turn_id: messages.turn_id is ON DELETE SET NULL,
    // so turn scope is enforced on write and on projection instead.
    const receipt = columns("messages").find(({ name }) => name === "initiative_context_json");
    if (receipt && (receipt.type !== "TEXT" || receipt.notnull !== 0)) {
      throw new Error("Unexpected initiative context metadata column.");
    }
    if (!receipt) {
      database.exec(`ALTER TABLE messages ADD COLUMN initiative_context_json TEXT
        CHECK (initiative_context_json IS NULL OR (
          role = 'system'
          AND length(initiative_context_json) BETWEEN 1 AND 512
          AND json_valid(initiative_context_json)
        ));`);
    }

    database.exec(`
      DROP TRIGGER IF EXISTS turn_execution_context_refs_prune_blob;
      CREATE TABLE turn_execution_context_refs_v100 (
        turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
        digest TEXT NOT NULL
          REFERENCES turn_execution_context_blobs(digest) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (
          kind IN (
            'attachment', 'file', 'diff', 'terminal', 'preview', 'review-note', 'initiative'
          )
        ),
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 4096),
        byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 65536),
        truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
        PRIMARY KEY (turn_id, ordinal)
      );
      INSERT INTO turn_execution_context_refs_v100 (
        turn_id, ordinal, digest, kind, label, byte_size, truncated
      )
      SELECT turn_id, ordinal, digest, kind, label, byte_size, truncated
      FROM turn_execution_context_refs;
      DROP TABLE turn_execution_context_refs;
      ALTER TABLE turn_execution_context_refs_v100
        RENAME TO turn_execution_context_refs;
      CREATE INDEX turn_execution_context_refs_digest_idx
        ON turn_execution_context_refs(digest);
      CREATE TRIGGER turn_execution_context_refs_prune_blob
      AFTER DELETE ON turn_execution_context_refs
      BEGIN
        DELETE FROM turn_execution_context_blobs
        WHERE digest = OLD.digest
          AND NOT EXISTS (
            SELECT 1 FROM turn_execution_context_refs
            WHERE turn_execution_context_refs.digest = OLD.digest
          );
      END;
    `);
  },
};
