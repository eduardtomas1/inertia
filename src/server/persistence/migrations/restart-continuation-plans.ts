import type { DatabaseMigrationDefinition } from "./catalog";

export const restartContinuationPlansMigration: DatabaseMigrationDefinition = {
  name: "PersistRestartContinuationPlans",
  up: `
    CREATE TABLE IF NOT EXISTS restart_continuation_plans (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      interrupted_turn_id TEXT NOT NULL,
      route_identity TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('waiting','dispatching','blocked','completed','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      turn_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
};
