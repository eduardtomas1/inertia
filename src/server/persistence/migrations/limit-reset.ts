import type { DatabaseMigrationDefinition } from "./catalog";

export const limitResetMigration: DatabaseMigrationDefinition = {
  name: "PersistUsageLimitResumePlans",
  up: `
    CREATE TABLE usage_limit_resume_plans (
      id TEXT NOT NULL UNIQUE,
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      failed_turn_id TEXT NOT NULL,
      route_identity TEXT NOT NULL,
      account_identity TEXT NOT NULL,
      resets_at TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('waiting','dispatching','blocked','completed','cancelled')),
      error TEXT CHECK (error IS NULL OR length(error) <= 1000),
      turn_id TEXT REFERENCES agent_turns(id) ON DELETE SET NULL
    );
    CREATE INDEX usage_limit_resume_due ON usage_limit_resume_plans(state, next_attempt_at);
  `,
};
