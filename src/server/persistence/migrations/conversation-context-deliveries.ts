import type { DatabaseMigrationDefinition } from "./catalog";

export const conversationContextDeliveriesMigration: DatabaseMigrationDefinition = {
  name: "ReferenceThisChatAndFreezeContextDeliveries",
  foreignKeys: "off",
  up: `
    DROP TRIGGER IF EXISTS conversation_context_packets_immutable;
    DROP TRIGGER IF EXISTS conversation_context_packets_consume_once;
    DROP TRIGGER IF EXISTS conversation_context_packets_discard_source_drafts;
    DROP TRIGGER IF EXISTS conversation_context_packets_draft_limit;
    DROP TRIGGER IF EXISTS agent_context_requests_discard_with_conversation;

    CREATE TABLE conversation_context_packets_v79 (
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
        CHECK (length(CAST(excerpts_json AS BLOB)) BETWEEN 2 AND 655360),
      message_count INTEGER NOT NULL CHECK (message_count BETWEEN 1 AND 2000),
      character_count INTEGER NOT NULL CHECK (character_count BETWEEN 1 AND 262144),
      created_at TEXT NOT NULL,
      consumed_message_id TEXT CHECK (
        consumed_message_id IS NULL OR length(consumed_message_id) = 36
      ),
      consumed_request_id TEXT CHECK (
        consumed_request_id IS NULL OR length(consumed_request_id) = 36
      ),
      consumed_at TEXT,
      dropped_message_count INTEGER NOT NULL DEFAULT 0
        CHECK (dropped_message_count BETWEEN 0 AND 1000000),
      transport_version INTEGER NOT NULL DEFAULT 1
        CHECK (transport_version IN (1, 2)),
      delivered_budget_bytes INTEGER CHECK (
        delivered_budget_bytes IS NULL OR delivered_budget_bytes BETWEEN 1 AND 262144
      ),
      delivered_message_count INTEGER CHECK (
        delivered_message_count IS NULL OR delivered_message_count BETWEEN 1 AND 2000
      ),
      delivered_character_count INTEGER CHECK (
        delivered_character_count IS NULL OR delivered_character_count BETWEEN 1 AND 262144
      ),
      delivered_omitted_count INTEGER CHECK (
        delivered_omitted_count IS NULL OR delivered_omitted_count BETWEEN 0 AND 1002000
      ),
      CHECK (
        (consumed_message_id IS NULL AND consumed_request_id IS NULL AND consumed_at IS NULL)
        OR
        (consumed_message_id IS NOT NULL AND consumed_request_id IS NOT NULL AND consumed_at IS NOT NULL)
      ),
      CHECK (
        (delivered_budget_bytes IS NULL AND delivered_message_count IS NULL
          AND delivered_character_count IS NULL AND delivered_omitted_count IS NULL)
        OR
        (transport_version = 2 AND consumed_message_id IS NOT NULL
          AND delivered_budget_bytes IS NOT NULL AND delivered_message_count IS NOT NULL
          AND delivered_character_count IS NOT NULL AND delivered_omitted_count IS NOT NULL)
      ),
      CHECK (
        transport_version = 1
        OR consumed_message_id IS NULL
        OR delivered_budget_bytes IS NOT NULL
      )
    );

    INSERT INTO conversation_context_packets_v79 (
      id, source_conversation_id, target_conversation_id,
      source_project_id, target_project_id,
      source_conversation_title, source_project_name,
      source_workspace_label, target_workspace_label, workspace_relation,
      note, excerpts_json, message_count, character_count, created_at,
      consumed_message_id, consumed_request_id, consumed_at,
      dropped_message_count, transport_version
    )
    SELECT
      id, source_conversation_id, target_conversation_id,
      source_project_id, target_project_id,
      source_conversation_title, source_project_name,
      source_workspace_label, target_workspace_label, workspace_relation,
      note, excerpts_json, message_count, character_count, created_at,
      consumed_message_id, consumed_request_id, consumed_at,
      dropped_message_count,
      CASE WHEN consumed_message_id IS NULL THEN 2 ELSE 1 END
    FROM conversation_context_packets;

    DROP TABLE conversation_context_packets;
    ALTER TABLE conversation_context_packets_v79
      RENAME TO conversation_context_packets;

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
      dropped_message_count,
      transport_version,
      created_at
    ON conversation_context_packets
    BEGIN
      SELECT RAISE(ABORT, 'conversation context packets are immutable');
    END;

    CREATE TRIGGER conversation_context_packets_consume_once
    BEFORE UPDATE OF
      consumed_message_id,
      consumed_request_id,
      consumed_at,
      delivered_budget_bytes,
      delivered_message_count,
      delivered_character_count,
      delivered_omitted_count
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
    ) >= 3
    BEGIN
      SELECT RAISE(ABORT, 'conversation context draft limit reached');
    END;

    CREATE TRIGGER agent_context_requests_discard_with_conversation
    BEFORE DELETE ON conversations
    BEGIN
      DELETE FROM agent_context_requests WHERE target_conversation_id = OLD.id;
    END;
  `,
};
