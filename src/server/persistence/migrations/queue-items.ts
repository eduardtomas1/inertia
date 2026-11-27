import type { DatabaseMigrationDefinition } from "./catalog";

export const QUEUE_ITEMS_SCHEMA_VERSION = 131;

export const queueItemsMigration: DatabaseMigrationDefinition = {
  name: "PersistQueueItemOrderDeliveryAndSelection",
  up: (database) => {
    const columns = new Set(
      (database.prepare("PRAGMA table_info(queued_messages)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    const additions: readonly (readonly [string, string])[] = [
      ["queue_position", "INTEGER CHECK (queue_position IS NULL OR queue_position >= 1)"],
      ["queue_held", "INTEGER NOT NULL DEFAULT 0 CHECK (queue_held IN (0, 1))"],
      ["kind", "TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message','watcher-note','delegated-results'))"],
      ["created_by", "TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','agent','system'))"],
      ["creation_source", "TEXT NOT NULL DEFAULT 'web' CHECK (creation_source IN ('web','mobile','mcp','server'))"],
      ["device_id", "TEXT CHECK (device_id IS NULL OR length(device_id) <= 240)"],
      ["steer_follow_up_of_run_id", "TEXT CHECK (steer_follow_up_of_run_id IS NULL OR length(steer_follow_up_of_run_id) <= 240)"],
      ["edit_revision", "INTEGER NOT NULL DEFAULT 0 CHECK (edit_revision >= 0)"],
      ["edited_at", "TEXT"],
      ["creation_digest", "TEXT CHECK (creation_digest IS NULL OR length(creation_digest) = 64)"],
      ["dispatch_ordinal", "INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_ordinal >= 0)"],
      ["run_id", "TEXT CHECK (run_id IS NULL OR length(run_id) <= 240)"],
      ["delivery_mode", "TEXT CHECK (delivery_mode IS NULL OR delivery_mode IN ('run','steer','after-stop'))"],
      ["steer_when_ready_run_id", "TEXT CHECK (steer_when_ready_run_id IS NULL OR length(steer_when_ready_run_id) <= 240)"],
      ["selection_json", "TEXT CHECK (selection_json IS NULL OR (json_valid(selection_json) AND json_type(selection_json) = 'object' AND length(CAST(selection_json AS BLOB)) <= 65536))"],
      ["follows_thread_selection", "INTEGER NOT NULL DEFAULT 0 CHECK (follows_thread_selection IN (0, 1))"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        database.exec(`ALTER TABLE queued_messages ADD COLUMN ${name} ${definition};`);
      }
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS queued_messages_conversation_state_position_idx
        ON queued_messages(conversation_id, state, queue_position);

      UPDATE queued_messages
      SET kind = 'delegated-results',
          follows_thread_selection = 1,
          created_by = 'system',
          creation_source = 'server'
      WHERE delegated_completion_json IS NOT NULL;

      UPDATE queued_messages
      SET kind = 'watcher-note',
          follows_thread_selection = 1,
          created_by = 'system',
          creation_source = 'server'
      WHERE delegated_completion_json IS NULL
        AND watcher_note_json IS NOT NULL;

      UPDATE queued_messages
      SET created_by = CASE
            WHEN (SELECT watcher_note_json FROM messages WHERE messages.id = queued_messages.user_message_id) IS NOT NULL
              OR (SELECT delegated_completion_json FROM messages WHERE messages.id = queued_messages.user_message_id) IS NOT NULL
              THEN 'system'
            ELSE 'user'
          END,
          creation_source = CASE
            WHEN (SELECT private_connect_device_id FROM messages WHERE messages.id = queued_messages.user_message_id) IS NOT NULL
              THEN 'mobile'
            WHEN (SELECT watcher_note_json FROM messages WHERE messages.id = queued_messages.user_message_id) IS NOT NULL
              OR (SELECT delegated_completion_json FROM messages WHERE messages.id = queued_messages.user_message_id) IS NOT NULL
              THEN 'server'
            ELSE 'web'
          END,
          device_id = (
            SELECT CASE
              WHEN private_connect_device_id IS NOT NULL AND length(private_connect_device_id) <= 240
                THEN private_connect_device_id
              ELSE NULL
            END
            FROM messages
            WHERE messages.id = queued_messages.user_message_id
          )
      WHERE delegated_completion_json IS NULL
        AND watcher_note_json IS NULL
        AND user_message_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM messages WHERE messages.id = queued_messages.user_message_id);

      UPDATE queued_messages
      SET creation_digest = intent_digest
      WHERE creation_digest IS NULL;

      UPDATE queued_messages
      SET steer_follow_up_of_run_id = (
        SELECT agent_turns.run_id
        FROM messages
        JOIN agent_turns ON agent_turns.id = messages.turn_id
        WHERE messages.id = queued_messages.user_message_id
          AND agent_turns.user_message_id <> messages.id
          AND length(agent_turns.run_id) <= 240
      )
      WHERE user_message_id IS NOT NULL
        AND turn_id IS NULL
        AND steer_follow_up_of_run_id IS NULL;

      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at ASC, sequence ASC) AS pos
        FROM queued_messages
        WHERE state IN ('waiting', 'dispatching', 'blocked')
          AND kind <> 'delegated-results'
      )
      UPDATE queued_messages
      SET queue_position = (SELECT pos FROM ranked WHERE ranked.id = queued_messages.id)
      WHERE id IN (SELECT id FROM ranked)
        AND queue_position IS NULL;

      UPDATE queued_messages
      SET selection_json = CASE
            WHEN json_extract(route_identity, '$[3].harnessId') = 'antigravity-cli'
              AND json_extract(route_identity, '$[3].backendProfileId') = 'builtin:antigravity'
            THEN json_set(json_extract(route_identity, '$[3]'), '$.harnessId', 'antigravity-acp')
            ELSE json_extract(route_identity, '$[3]')
          END,
          route_identity = CASE
            WHEN json_extract(route_identity, '$[3].harnessId') = 'antigravity-cli'
              AND json_extract(route_identity, '$[3].backendProfileId') = 'builtin:antigravity'
            THEN json_set(route_identity, '$[3].harnessId', 'antigravity-acp')
            ELSE route_identity
          END
      WHERE kind = 'message'
        AND selection_json IS NULL
        AND json_valid(route_identity)
        AND json_type(route_identity) = 'array'
        AND json_type(route_identity, '$[3]') = 'object'
        AND length(CAST(json_extract(route_identity, '$[3]') AS BLOB)) <= 65536;

      DELETE FROM orchestration_v2_receipts
      WHERE thread_id NOT IN (SELECT id FROM conversations);
    `);
  },
};
