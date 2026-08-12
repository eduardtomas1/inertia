import type { DatabaseMigrationDefinition } from "./catalog";

export const providerRunOwnershipMigration: DatabaseMigrationDefinition = {
  name: "PersistOwnedProviderRuns",
  up: `
    CREATE UNIQUE INDEX agent_turns_provider_run_identity_idx
      ON agent_turns(id, conversation_id, run_id);
    CREATE TABLE provider_run_ownership (
      turn_id TEXT NOT NULL PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      runtime_generation_id TEXT NOT NULL,
      system_boot_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (turn_id, conversation_id, run_id)
        REFERENCES agent_turns(id, conversation_id, run_id)
        ON DELETE RESTRICT,
      CHECK (length(turn_id) BETWEEN 1 AND 200),
      CHECK (length(conversation_id) BETWEEN 1 AND 200),
      CHECK (length(run_id) BETWEEN 1 AND 200),
      CHECK (length(runtime_generation_id) BETWEEN 38 AND 80),
      CHECK (length(system_boot_id) BETWEEN 8 AND 80),
      CHECK (length(created_at) BETWEEN 20 AND 40)
    );
    CREATE INDEX provider_run_ownership_conversation_idx
      ON provider_run_ownership(conversation_id, created_at, turn_id);
  `,
};
