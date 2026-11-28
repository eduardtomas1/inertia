import type { DatabaseMigrationDefinition } from "./catalog";

export const SCHEDULED_TASKS_SCHEMA_VERSION = 132;

export const scheduledTasksMigration: DatabaseMigrationDefinition = {
  name: "PersistScheduledTasks",
  up: `
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      bound_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      fresh_session INTEGER NOT NULL DEFAULT 0 CHECK (fresh_session IN (0, 1)),
      model_selection_json TEXT,
      interaction_mode TEXT NOT NULL DEFAULT 'build' CHECK (interaction_mode IN ('build', 'plan')),
      access_mode TEXT NOT NULL DEFAULT 'supervised' CHECK (access_mode IN ('supervised', 'auto-edit', 'full')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_status TEXT CHECK (last_run_status IS NULL OR last_run_status IN ('claimed','queued','running','completed','failed','skipped')),
      last_conversation_id TEXT,
      last_turn_id TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'agent')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      claim_key TEXT NOT NULL UNIQUE,
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
      scheduled_for TEXT,
      state TEXT NOT NULL CHECK (state IN ('claimed','queued','running','completed','failed','skipped')),
      conversation_id TEXT,
      turn_id TEXT,
      queue_item_id TEXT,
      error TEXT,
      claimed_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS scheduled_tasks_project_idx
      ON scheduled_tasks (project_id, updated_at DESC, id ASC);
    CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx
      ON scheduled_tasks (enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS scheduled_task_runs_task_idx
      ON scheduled_task_runs (task_id, claimed_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS scheduled_task_runs_turn_idx
      ON scheduled_task_runs (turn_id) WHERE turn_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS scheduled_tasks_project_limit
      BEFORE INSERT ON scheduled_tasks
      WHEN (SELECT COUNT(*) FROM scheduled_tasks WHERE project_id = NEW.project_id) >= 100
      BEGIN
        SELECT RAISE(ABORT, 'A project can have at most 100 scheduled tasks.');
      END;
  `,
};
