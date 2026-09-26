import type Database from "better-sqlite3";

/** Full replacements need a revision even when the UTF-8 byte length is unchanged. */
export function addConversationContentRevisions(database: Database.Database): void {
  database.exec(`
    CREATE INDEX agent_turns_history_order_idx ON agent_turns(conversation_id, created_at, id);
    CREATE INDEX subagents_history_order_idx ON subagent_traces(conversation_id, created_at, id);
    CREATE INDEX agent_plans_history_order_idx ON agent_plans(conversation_id, updated_at, run_id) WHERE turn_id IS NULL;
    CREATE TABLE conversation_content_revisions (
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (kind, record_id)
    );
  `);
  for (const [kind, table, column] of [
    ["message", "messages", "content"],
    ["reasoning", "agent_reasonings", "content"],
    ["activity", "activities", "detail"],
  ] as const) {
    database.exec(`
      CREATE TRIGGER ${table}_history_revision AFTER UPDATE OF ${column} ON ${table}
      WHEN old.${column} IS NOT new.${column}
      BEGIN
        INSERT INTO conversation_content_revisions (kind, record_id, revision)
        VALUES ('${kind}', new.id, 1)
        ON CONFLICT (kind, record_id) DO UPDATE SET revision = revision + 1;
      END;
      CREATE TRIGGER ${table}_history_revision_delete AFTER DELETE ON ${table}
      BEGIN
        DELETE FROM conversation_content_revisions WHERE kind = '${kind}' AND record_id = old.id;
      END;
    `);
  }
}
