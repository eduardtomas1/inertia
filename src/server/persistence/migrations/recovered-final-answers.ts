import type { DatabaseMigrationDefinition } from "./catalog";

export const recoveredFinalAnswersMigration: DatabaseMigrationDefinition = {
  name: "PreserveRecoveredFinalAnswerProvenance",
  up: `CREATE TABLE recovered_final_answers (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE
  );`,
};
