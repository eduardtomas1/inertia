import type Database from "better-sqlite3";

import { protectDuoComparisonDeletion } from "./duo-deletion-trigger";

export function persistDuoThirdModelComparison(
  database: Database.Database,
): void {
  const columns = database.prepare("PRAGMA table_info(paired_launches)")
    .all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "comparison_state")) {
    database.exec(`
      ALTER TABLE paired_launches ADD COLUMN comparison_state TEXT
        CHECK (
          comparison_state IS NULL
          OR comparison_state IN (
            'waiting', 'dispatching', 'running', 'completed', 'failed',
            'cancelled', 'interrupted'
          )
        );
    `);
  }
  if (!columns.some(({ name }) => name === "comparison_planned_conversation_id")) {
    database.exec(`
      ALTER TABLE paired_launches
        ADD COLUMN comparison_planned_conversation_id TEXT
        CHECK (
          comparison_planned_conversation_id IS NULL
          OR length(comparison_planned_conversation_id) = 36
        );
    `);
  }
  if (!columns.some(({ name }) => name === "comparison_conversation_id")) {
    database.exec(`
      ALTER TABLE paired_launches ADD COLUMN comparison_conversation_id TEXT
        REFERENCES conversations(id) ON DELETE SET NULL
        CHECK (
          comparison_conversation_id IS NULL
          OR length(comparison_conversation_id) = 36
        );
    `);
  }
  if (!columns.some(({ name }) => name === "comparison_turn_id")) {
    database.exec(`
      ALTER TABLE paired_launches ADD COLUMN comparison_turn_id TEXT
        REFERENCES agent_turns(id) ON DELETE SET NULL
        CHECK (
          comparison_turn_id IS NULL
          OR length(comparison_turn_id) = 36
        );
    `);
  }
  if (!columns.some(({ name }) => name === "comparison_attempt")) {
    database.exec(`
      ALTER TABLE paired_launches
        ADD COLUMN comparison_attempt INTEGER NOT NULL DEFAULT 0
        CHECK (comparison_attempt BETWEEN 0 AND 1000);
    `);
  }
  if (!columns.some(({ name }) => name === "comparison_failure_message")) {
    database.exec(`
      ALTER TABLE paired_launches
        ADD COLUMN comparison_failure_message TEXT
        CHECK (
          comparison_failure_message IS NULL
          OR length(comparison_failure_message) <= 2000
        );
    `);
  }
  protectDuoComparisonDeletion(database);
}
