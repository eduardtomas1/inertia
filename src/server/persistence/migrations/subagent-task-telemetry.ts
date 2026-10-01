import type { DatabaseMigrationDefinition } from "./catalog";

export const subagentTaskTelemetryMigration: DatabaseMigrationDefinition = {
  name: "PersistSubagentTaskTelemetry",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(subagent_traces)")
      .all() as Array<{ name: string }>;
    const statements = [
      ["model", `
        ALTER TABLE subagent_traces ADD COLUMN model TEXT
          CHECK (model IS NULL OR length(model) <= 200);
      `],
      ["activity", `
        ALTER TABLE subagent_traces ADD COLUMN activity TEXT
          CHECK (activity IS NULL OR length(activity) <= 200);
      `],
      ["usage_json", `
        ALTER TABLE subagent_traces ADD COLUMN usage_json TEXT
          CHECK (usage_json IS NULL OR (json_valid(usage_json) AND length(usage_json) <= 512));
      `],
      ["tool_use_count", `
        ALTER TABLE subagent_traces ADD COLUMN tool_use_count INTEGER
          CHECK (tool_use_count IS NULL OR tool_use_count >= 0);
      `],
      ["duration_ms", `
        ALTER TABLE subagent_traces ADD COLUMN duration_ms INTEGER
          CHECK (duration_ms IS NULL OR duration_ms >= 0);
      `],
    ] as const;
    for (const [column, statement] of statements) {
      if (!columns.some(({ name }) => name === column)) database.exec(statement);
    }
  },
};
