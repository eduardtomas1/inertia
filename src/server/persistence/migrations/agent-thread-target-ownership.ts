import type { DatabaseMigrationDefinition } from "./catalog";

/** Legacy operations have no exact target receipt and cannot cancel newer runs. */
export const agentThreadTargetOwnershipMigration: DatabaseMigrationDefinition = {
  name: "PersistAgentThreadTargetOwnership",
  up: `
    ALTER TABLE agent_thread_operations ADD COLUMN target_turn_id TEXT
      CHECK (target_turn_id IS NULL OR length(target_turn_id) BETWEEN 1 AND 256);
    ALTER TABLE agent_thread_operations ADD COLUMN target_run_id TEXT
      CHECK (target_run_id IS NULL OR length(target_run_id) BETWEEN 1 AND 256);
  `,
};
