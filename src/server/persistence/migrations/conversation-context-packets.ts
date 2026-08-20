import type { DatabaseMigrationDefinition } from "./catalog";

/**
 * Context packets quote a user-approved, bounded transcript selection. Source
 * identities are snapshots rather than foreign keys so sent provenance remains
 * truthful if its source chat is later deleted. Unsent packets are removed by
 * the source-deletion trigger; target deletion still owns the packet lifetime.
 */
export const conversationContextPacketsMigration: DatabaseMigrationDefinition = {
  name: "PersistConversationContextPackets",
  up: `
    CREATE TABLE conversation_context_packets (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      source_conversation_id TEXT NOT NULL CHECK (length(source_conversation_id) = 36),
      target_conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE
        CHECK (length(target_conversation_id) = 36),
      source_project_id TEXT NOT NULL CHECK (length(source_project_id) = 36),
      target_project_id TEXT NOT NULL CHECK (length(target_project_id) = 36),
      source_conversation_title TEXT NOT NULL
        CHECK (length(source_conversation_title) BETWEEN 1 AND 120),
      source_project_name TEXT NOT NULL
        CHECK (length(source_project_name) BETWEEN 1 AND 80),
      source_workspace_label TEXT NOT NULL
        CHECK (length(source_workspace_label) BETWEEN 1 AND 280),
      target_workspace_label TEXT NOT NULL
        CHECK (length(target_workspace_label) BETWEEN 1 AND 280),
      workspace_relation TEXT NOT NULL
        CHECK (workspace_relation IN ('same-workspace', 'different-workspace')),
      note TEXT CHECK (note IS NULL OR length(CAST(note AS BLOB)) BETWEEN 1 AND 1024),
      excerpts_json TEXT NOT NULL
        CHECK (length(CAST(excerpts_json AS BLOB)) BETWEEN 2 AND 65536),
      message_count INTEGER NOT NULL CHECK (message_count BETWEEN 1 AND 12),
      character_count INTEGER NOT NULL CHECK (character_count BETWEEN 1 AND 12288),
      created_at TEXT NOT NULL,
      consumed_message_id TEXT CHECK (
        consumed_message_id IS NULL OR length(consumed_message_id) = 36
      ),
      consumed_request_id TEXT CHECK (
        consumed_request_id IS NULL OR length(consumed_request_id) = 36
      ),
      consumed_at TEXT,
      CHECK (source_conversation_id <> target_conversation_id),
      CHECK (
        (consumed_message_id IS NULL AND consumed_request_id IS NULL AND consumed_at IS NULL)
        OR
        (consumed_message_id IS NOT NULL AND consumed_request_id IS NOT NULL AND consumed_at IS NOT NULL)
      )
    );

    CREATE INDEX conversation_context_packets_target_state_idx
      ON conversation_context_packets(
        target_conversation_id,
        consumed_message_id,
        created_at ASC,
        id ASC
      );
    CREATE INDEX conversation_context_packets_source_draft_idx
      ON conversation_context_packets(source_conversation_id)
      WHERE consumed_message_id IS NULL;
    CREATE UNIQUE INDEX conversation_context_packets_request_idx
      ON conversation_context_packets(consumed_request_id, id)
      WHERE consumed_request_id IS NOT NULL;

    CREATE TRIGGER conversation_context_packets_immutable
    BEFORE UPDATE OF
      source_conversation_id,
      target_conversation_id,
      source_project_id,
      target_project_id,
      source_conversation_title,
      source_project_name,
      source_workspace_label,
      target_workspace_label,
      workspace_relation,
      note,
      excerpts_json,
      message_count,
      character_count,
      created_at
    ON conversation_context_packets
    BEGIN
      SELECT RAISE(ABORT, 'conversation context packets are immutable');
    END;

    CREATE TRIGGER conversation_context_packets_consume_once
    BEFORE UPDATE OF consumed_message_id, consumed_request_id, consumed_at
    ON conversation_context_packets
    WHEN OLD.consumed_message_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'conversation context packets can only be consumed once');
    END;

    CREATE TRIGGER conversation_context_packets_discard_source_drafts
    AFTER DELETE ON conversations
    BEGIN
      DELETE FROM conversation_context_packets
      WHERE source_conversation_id = OLD.id
        AND consumed_message_id IS NULL;
    END;

    CREATE TRIGGER conversation_context_packets_draft_limit
    BEFORE INSERT ON conversation_context_packets
    WHEN NEW.consumed_message_id IS NULL AND (
      SELECT COUNT(*) FROM conversation_context_packets
      WHERE target_conversation_id = NEW.target_conversation_id
        AND consumed_message_id IS NULL
    ) >= 2
    BEGIN
      SELECT RAISE(ABORT, 'conversation context draft limit reached');
    END;

    CREATE TABLE agent_context_requests (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      target_conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE
        CHECK (length(target_conversation_id) = 36),
      target_turn_id TEXT NOT NULL
        REFERENCES agent_turns(id) ON DELETE CASCADE
        CHECK (length(target_turn_id) BETWEEN 1 AND 200),
      target_user_message_id TEXT NOT NULL
        REFERENCES messages(id) ON DELETE CASCADE
        CHECK (length(target_user_message_id) BETWEEN 1 AND 200),
      target_run_id TEXT NOT NULL CHECK (length(target_run_id) BETWEEN 1 AND 200),
      source_harness_id TEXT NOT NULL
        CHECK (
          length(source_harness_id) BETWEEN 1 AND 64
          AND source_harness_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
      requested_source_conversation_id TEXT CHECK (
          requested_source_conversation_id IS NULL
          OR length(requested_source_conversation_id) = 36
        ),
      selected_source_conversation_id TEXT CHECK (
        selected_source_conversation_id IS NULL
        OR length(selected_source_conversation_id) = 36
      ),
      tool_call_id_hash TEXT NOT NULL CHECK (length(tool_call_id_hash) = 64),
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      status TEXT NOT NULL CHECK (status IN (
        'selection-pending', 'completed', 'denied', 'cancelled',
        'expired', 'interrupted', 'failed'
      )),
      packet_id TEXT UNIQUE
        REFERENCES conversation_context_packets(id) ON DELETE SET NULL,
      result_json TEXT CHECK (
        result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 32768
      ),
      failure_message TEXT CHECK (
        failure_message IS NULL OR length(failure_message) <= 1000
      ),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(target_turn_id, tool_call_id_hash),
      CHECK (
        requested_source_conversation_id IS NULL
        OR requested_source_conversation_id <> target_conversation_id
      ),
      CHECK (
        (status = 'completed'
          AND packet_id IS NOT NULL
          AND result_json IS NOT NULL
          AND selected_source_conversation_id IS NOT NULL)
        OR
        (status <> 'completed'
          AND packet_id IS NULL
          AND result_json IS NULL
          AND selected_source_conversation_id IS NULL)
      )
    );
    CREATE INDEX agent_context_requests_target_status_idx
      ON agent_context_requests(
        target_conversation_id,
        status,
        created_at ASC,
        id ASC
      );
  `,
};
