import type { DatabaseMigrationDefinition } from "./catalog";

export const worktreeSetupMigration: DatabaseMigrationDefinition = {
  name: "PersistWorktreeSetup",
  up: `
    ALTER TABLE conversations ADD COLUMN worktree_setup_json TEXT;
    CREATE TABLE worktree_setups (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      action_json TEXT NOT NULL,
      output TEXT NOT NULL DEFAULT '' CHECK (length(output) <= 16384)
    );
  `,
};
