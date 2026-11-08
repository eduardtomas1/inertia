import type Database from "better-sqlite3";

import type { DatabaseMigrationDefinition } from "./catalog";

const DELEGATION_OPERATION_TOOLS = ["inertia_create_conversation", "inertia_send_message", "inertia_stop_conversation",
  "inertia_archive_conversation", "inertia_delegate_task", "inertia_cancel_task"] as const;

function delegationIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function delegationColumns(database: Database.Database, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${delegationIdentifier(table)})`).all() as { name: string }[])
    .map(({ name }) => name);
}

function delegationCompletionCheck(column: string, userOnly: boolean): string {
  return `CHECK (${column} IS NULL OR (
    ${userOnly ? "role = 'user' AND " : ""}watcher_note_json IS NULL
    AND json_valid(${column})
    AND json_type(${column}) IS 'object'
    AND json_type(${column}, '$.parentConversationId') IS 'text'
    AND json_type(${column}, '$.generation') IS 'integer'
    AND json_extract(${column}, '$.generation') > 0
    AND json_type(${column}, '$.taskIds') IS 'array'
    AND json_array_length(${column}, '$.taskIds') BETWEEN 1 AND 16
    AND length(CAST(${column} AS BLOB)) <= 1024
  ))`;
}

function widenDelegationOperationTools(database: Database.Database): void {
  const table = "agent_thread_operations";
  const replacement = "agent_thread_operations_v111";
  const header = /^CREATE TABLE (?:"agent_thread_operations"|agent_thread_operations)\s*\(/u;
  const toolCheck = /(\btool_name\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*tool_name\s+IN\s*\()([^)]*)(\))/iu;
  const current = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  const match = current && header.test(current.sql) ? toolCheck.exec(current.sql) : null;
  if (!current || !match) throw new Error("The managed-chat operation schema is not the expected version.");
  const names = [...match[2]!.matchAll(/'([a-z_]+)'/gu)].map((entry) => entry[1]!);
  if (DELEGATION_OPERATION_TOOLS.every((name) => names.includes(name)) && names.length === DELEGATION_OPERATION_TOOLS.length) return;
  if (names.length !== 4 || DELEGATION_OPERATION_TOOLS.slice(0, 4).some((name) => !names.includes(name))) {
    throw new Error("The managed-chat operation tool constraint is not the expected version.");
  }
  const triggers = database.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL
    AND (tbl_name = ? OR instr(sql, ?) > 0) ORDER BY name`).all(table, table) as { name: string; sql: string }[];
  const indexes = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
    ORDER BY name`).all(table) as { sql: string }[];
  const columns = delegationColumns(database, table).map(delegationIdentifier).join(", ");
  const rows = (database.prepare(`SELECT COUNT(*) AS count FROM ${delegationIdentifier(table)}`).get() as { count: number }).count;
  for (const { name } of triggers) database.exec(`DROP TRIGGER ${delegationIdentifier(name)}`);
  const widened = DELEGATION_OPERATION_TOOLS.map((name) => `\n        '${name}'`).join(",");
  database.exec(current.sql.replace(header, `CREATE TABLE ${delegationIdentifier(replacement)} (`)
    .replace(toolCheck, (_match, prefix: string, _values: string, suffix: string) => `${prefix}${widened}\n      ${suffix}`));
  database.exec(`INSERT INTO ${delegationIdentifier(replacement)} (${columns}) SELECT ${columns} FROM ${delegationIdentifier(table)}`);
  const copied = (database.prepare(`SELECT COUNT(*) AS count FROM ${delegationIdentifier(replacement)}`).get() as { count: number }).count;
  if (copied !== rows) throw new Error("The managed-chat operation rebuild lost rows.");
  database.exec(`DROP TABLE ${delegationIdentifier(table)}`);
  database.exec(`ALTER TABLE ${delegationIdentifier(replacement)} RENAME TO ${delegationIdentifier(table)}`);
  for (const { sql } of indexes) database.exec(sql);
  for (const { sql } of triggers) database.exec(sql);
}

function addDelegationColumn(database: Database.Database, table: string, column: string, definition: string): void {
  if (delegationColumns(database, table).includes(column)) return;
  database.exec(`ALTER TABLE ${delegationIdentifier(table)} ADD COLUMN ${column} ${definition}`);
}

export const delegatedTasksMigration: DatabaseMigrationDefinition = {
  name: "PersistDelegatedTasks",
  foreignKeys: "off",
  up: (database) => {
    widenDelegationOperationTools(database);
    addDelegationColumn(database, "agent_thread_operations", "client_request_key", `TEXT
      CHECK (client_request_key IS NULL OR (length(client_request_key) = 64 AND client_request_key NOT GLOB '*[^0-9a-f]*'))`);
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agent_thread_operations_client_request_idx
      ON agent_thread_operations(source_conversation_id, client_request_key) WHERE client_request_key IS NOT NULL`);
    addDelegationColumn(database, "queued_messages", "delegated_completion_json",
      `TEXT ${delegationCompletionCheck("delegated_completion_json", false)}`);
    addDelegationColumn(database, "messages", "delegated_completion_json",
      `TEXT ${delegationCompletionCheck("delegated_completion_json", true)}`);
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS queued_messages_delegated_delivery_idx ON queued_messages(conversation_id)
        WHERE delegated_completion_json IS NOT NULL AND state IN ('waiting','dispatching','blocked');
      CREATE TABLE IF NOT EXISTS delegated_tasks (
        task_id TEXT PRIMARY KEY CHECK (length(task_id) = 64 AND task_id NOT GLOB '*[^0-9a-f]*'),
        parent_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source_turn_id TEXT REFERENCES agent_turns(id) ON DELETE SET NULL,
        source_run_id TEXT NOT NULL CHECK (length(source_run_id) BETWEEN 1 AND 256),
        child_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        operation_id TEXT REFERENCES agent_thread_operations(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('original','follow-up')),
        original_task_id TEXT CHECK (original_task_id IS NULL OR length(original_task_id) = 64),
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled','interrupted')),
        completion_wake TEXT NOT NULL CHECK (completion_wake IN ('always','settled_only','never')),
        wake_armed INTEGER NOT NULL CHECK (wake_armed IN (0,1)),
        delivery_state TEXT CHECK (delivery_state IS NULL
          OR delivery_state IN ('pending','claimed','delivered','acknowledged','disposed')),
        delivery_generation INTEGER CHECK (delivery_generation IS NULL OR delivery_generation > 0),
        result_turn_id TEXT CHECK (result_turn_id IS NULL OR length(result_turn_id) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (parent_conversation_id <> child_conversation_id),
        CHECK ((kind = 'original') = (original_task_id IS NULL)),
        CHECK ((status = 'running') = (result_turn_id IS NULL)),
        CHECK (completion_wake <> 'never' OR wake_armed = 0)
      );
      CREATE INDEX IF NOT EXISTS delegated_tasks_parent_delivery_idx
        ON delegated_tasks(parent_conversation_id, delivery_state, status);
      CREATE INDEX IF NOT EXISTS delegated_tasks_child_status_idx ON delegated_tasks(child_conversation_id, status);
      CREATE INDEX IF NOT EXISTS delegated_tasks_source_turn_idx ON delegated_tasks(source_turn_id);
      CREATE TABLE IF NOT EXISTS delegated_task_turns (
        child_turn_id TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES delegated_tasks(task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS delegated_task_turns_task_idx ON delegated_task_turns(task_id);
    `);
  },
};
