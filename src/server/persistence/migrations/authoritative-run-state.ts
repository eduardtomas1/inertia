import type { DatabaseMigrationDefinition } from "./catalog";

/**
 * Adds the fine-grained live execution state without rebuilding the released
 * turn ledger. `status` remains the compatibility/terminal projection; all new
 * runtime writes update both columns in one guarded statement.
 */
export const authoritativeRunStateMigration: DatabaseMigrationDefinition = {
  name: "PersistAuthoritativeRunState",
  up: `
    ALTER TABLE agent_turns ADD COLUMN run_state TEXT NOT NULL DEFAULT 'queued'
      CHECK (run_state IN (
        'queued', 'starting', 'running', 'delegated', 'retrying',
        'waiting-for-approval', 'waiting-for-input', 'cancelling',
        'completed', 'failed', 'cancelled', 'interrupted'
      ));
    ALTER TABLE agent_turns ADD COLUMN provider_state TEXT
      CHECK (provider_state IS NULL OR length(provider_state) BETWEEN 1 AND 200);
    ALTER TABLE agent_turns ADD COLUMN run_state_revision INTEGER NOT NULL DEFAULT 0
      CHECK (run_state_revision BETWEEN 0 AND 2147483647);
    UPDATE agent_turns SET run_state = status;
    CREATE INDEX agent_turns_run_state_requested_idx
      ON agent_turns(run_state, requested_at ASC, id ASC);
  `,
};
