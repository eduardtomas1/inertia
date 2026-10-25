import type { DatabaseMigrationDefinition } from "./catalog";

export const persistTurnFailureKindsMigration: DatabaseMigrationDefinition = {
  name: "PersistTurnFailureKinds",
  up: `
    CREATE TABLE IF NOT EXISTS turn_failure_kinds (
      turn_id TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE,
      failure_kind TEXT NOT NULL
        CHECK (failure_kind IN ('billing', 'authentication', 'rate-limited', 'model-not-found'))
    );
  `,
};
