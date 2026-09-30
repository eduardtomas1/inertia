import type { DatabaseMigrationDefinition } from "./catalog";

export const turnSessionRecoveryMigration: DatabaseMigrationDefinition = {
  name: "PersistTurnSessionRecovery",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(agent_turns)")
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "session_recovery_json")) {
      return;
    }
    database.exec(`
      ALTER TABLE agent_turns
        ADD COLUMN session_recovery_json TEXT
        CHECK (
          session_recovery_json IS NULL
          OR length(session_recovery_json) BETWEEN 2 AND 256
        );
    `);
  },
};
