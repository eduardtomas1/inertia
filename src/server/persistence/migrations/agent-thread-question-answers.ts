import type { DatabaseMigrationDefinition } from "./catalog";

export const AGENT_THREAD_QUESTION_ANSWERS_SCHEMA_VERSION = 119;

/**
 * Lets the managed-chat operation log record `inertia_answer_question`, so an
 * answer to a child chat's question gets the same approval record, replay
 * receipt and per-turn budget as the other chat actions. SQLite cannot widen a
 * CHECK constraint in place, so the table is rebuilt with every column, row,
 * and index unchanged, the two target columns schema 82 appended included.
 */
export const agentThreadQuestionAnswersMigration: DatabaseMigrationDefinition = {
  name: "RecordAgentThreadQuestionAnswers",
  foreignKeys: "off",
  up: `
    CREATE TABLE agent_thread_operations_v119 (
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
        'inertia_archive_conversation',
        'inertia_answer_question'
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
      target_turn_id TEXT
        CHECK (target_turn_id IS NULL OR length(target_turn_id) BETWEEN 1 AND 256),
      target_run_id TEXT
        CHECK (target_run_id IS NULL OR length(target_run_id) BETWEEN 1 AND 256),
      UNIQUE(source_turn_id, tool_call_id_hash)
    );
    INSERT INTO agent_thread_operations_v119 (
      id, source_conversation_id, source_turn_id, source_run_id,
      tool_call_id_hash, tool_name, request_fingerprint, status,
      child_conversation_id, input_chars, result_json, failure_message,
      created_at, updated_at, target_turn_id, target_run_id
    )
    SELECT id, source_conversation_id, source_turn_id, source_run_id,
      tool_call_id_hash, tool_name, request_fingerprint, status,
      child_conversation_id, input_chars, result_json, failure_message,
      created_at, updated_at, target_turn_id, target_run_id
    FROM agent_thread_operations;
    DROP TABLE agent_thread_operations;
    ALTER TABLE agent_thread_operations_v119 RENAME TO agent_thread_operations;
    CREATE INDEX agent_thread_operations_source_turn_idx
      ON agent_thread_operations(source_turn_id, created_at, id);
    CREATE INDEX agent_thread_operations_child_idx
      ON agent_thread_operations(child_conversation_id, created_at, id);
  `,
};
