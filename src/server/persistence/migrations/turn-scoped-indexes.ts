import type { DatabaseMigrationDefinition } from "./catalog";

export const turnScopedIndexesMigration: DatabaseMigrationDefinition = {
  name: "IndexTurnScopedRows",
  up: `
    CREATE INDEX IF NOT EXISTS activities_turn_idx
      ON activities(turn_id) WHERE turn_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_turn_idx
      ON messages(turn_id) WHERE turn_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS agent_reasonings_turn_idx
      ON agent_reasonings(turn_id) WHERE turn_id IS NOT NULL;
    DROP INDEX IF EXISTS activities_conversation_id_idx;
    DROP INDEX IF EXISTS messages_conversation_id_idx;
    DROP INDEX IF EXISTS agent_reasonings_conversation_id_idx;
  `,
};
