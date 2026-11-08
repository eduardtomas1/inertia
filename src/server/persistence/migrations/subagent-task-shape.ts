import type { DatabaseMigrationDefinition } from "./catalog";

export const SUBAGENT_TASK_SHAPE_SCHEMA_VERSION = 111;

export const subagentTaskShapeMigration: DatabaseMigrationDefinition = {
  name: "PersistSubagentTaskShape",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(subagent_traces)")
      .all() as Array<{ name: string }>;
    const statements = [
      ["task_kind", `
        ALTER TABLE subagent_traces ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'agent'
          CHECK (task_kind IN ('agent', 'workflow', 'shell', 'monitor', 'remote', 'mcp'));
      `],
      ["background", `
        ALTER TABLE subagent_traces ADD COLUMN background INTEGER
          CHECK (background IS NULL OR background IN (0, 1));
      `],
      ["command", `
        ALTER TABLE subagent_traces ADD COLUMN command TEXT
          CHECK (command IS NULL OR length(command) BETWEEN 1 AND 4000);
      `],
      ["effort", `
        ALTER TABLE subagent_traces ADD COLUMN effort TEXT
          CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
      `],
      ["activity_id", `
        ALTER TABLE subagent_traces ADD COLUMN activity_id TEXT
          CHECK (activity_id IS NULL OR length(activity_id) BETWEEN 1 AND 200);
      `],
      ["model_source", `
        ALTER TABLE subagent_traces ADD COLUMN model_source TEXT
          CHECK (model_source IS NULL OR model_source IN ('observed', 'requested'));
      `],
      ["steps_json", `
        ALTER TABLE subagent_traces ADD COLUMN steps_json TEXT
          CHECK (steps_json IS NULL OR (
            json_valid(steps_json)
            AND json_type(steps_json) = 'array'
            AND length(steps_json) <= 4096
          ));
      `],
    ] as const;
    for (const [column, statement] of statements) {
      if (!columns.some(({ name }) => name === column)) database.exec(statement);
    }
  },
};
