import type { DatabaseMigrationDefinition } from "./catalog";

/** Durable provenance and exactly-once receipts for host-owned chat tools. */
export const persistAgentThreadManagement: DatabaseMigrationDefinition = {
  name: "PersistAgentThreadManagement",
  up: `
    CREATE TABLE agent_managed_conversations (
      child_conversation_id TEXT PRIMARY KEY
        REFERENCES conversations(id) ON DELETE CASCADE,
      source_conversation_id TEXT
        REFERENCES conversations(id) ON DELETE SET NULL,
      source_turn_id TEXT
        REFERENCES agent_turns(id) ON DELETE SET NULL,
      source_run_id TEXT NOT NULL
        CHECK (length(source_run_id) BETWEEN 1 AND 128),
      root_conversation_id TEXT NOT NULL
        CHECK (length(root_conversation_id) BETWEEN 1 AND 128),
      source_harness_id TEXT NOT NULL
        CHECK (
          length(source_harness_id) BETWEEN 1 AND 64
          AND source_harness_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
      depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 2),
      created_at TEXT NOT NULL
    );
    CREATE INDEX agent_managed_conversations_source_turn_idx
      ON agent_managed_conversations(source_turn_id, created_at, child_conversation_id);
    CREATE INDEX agent_managed_conversations_root_idx
      ON agent_managed_conversations(root_conversation_id, depth, created_at);

    CREATE TABLE agent_thread_operations (
      id TEXT PRIMARY KEY CHECK (length(id) = 64),
      source_conversation_id TEXT
        REFERENCES conversations(id) ON DELETE SET NULL,
      source_turn_id TEXT
        REFERENCES agent_turns(id) ON DELETE SET NULL,
      source_run_id TEXT NOT NULL
        CHECK (length(source_run_id) BETWEEN 1 AND 128),
      tool_call_id_hash TEXT NOT NULL CHECK (length(tool_call_id_hash) = 64),
      tool_name TEXT NOT NULL CHECK (tool_name IN (
        'inertia_create_conversation',
        'inertia_send_message',
        'inertia_stop_conversation',
        'inertia_archive_conversation'
      )),
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      status TEXT NOT NULL CHECK (status IN (
        'approval-pending', 'approved', 'creating', 'dispatching',
        'completed', 'denied', 'failed', 'interrupted'
      )),
      child_conversation_id TEXT
        REFERENCES conversations(id) ON DELETE SET NULL,
      input_chars INTEGER NOT NULL CHECK (input_chars BETWEEN 0 AND 65536),
      result_json TEXT CHECK (
        result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 32768
      ),
      failure_message TEXT CHECK (
        failure_message IS NULL OR length(failure_message) <= 1000
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_turn_id, tool_call_id_hash)
    );
    CREATE INDEX agent_thread_operations_source_turn_idx
      ON agent_thread_operations(source_turn_id, created_at, id);
    CREATE INDEX agent_thread_operations_child_idx
      ON agent_thread_operations(child_conversation_id, created_at, id);

    -- Codex App Server 0.114.0 accepts dynamic tools only on thread/start.
    -- Sessions saved before this migration therefore cannot truthfully expose
    -- the Inertia chat manager. Drop only that opaque provider identity so the
    -- next turn starts a registered provider thread; the Inertia conversation,
    -- visible transcript, turns, and configuration remain intact.
    DELETE FROM agent_goals
    WHERE source = 'codex-native'
      AND conversation_id IN (
        SELECT id FROM conversations
        WHERE provider_id = 'codex' AND provider_session_id IS NOT NULL
      );
    UPDATE conversations
    SET provider_session_id = NULL, continuation_identity_json = NULL
    WHERE provider_id = 'codex' AND provider_session_id IS NOT NULL;
  `,
};
