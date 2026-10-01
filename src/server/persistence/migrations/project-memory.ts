import type { DatabaseMigrationDefinition } from "./catalog";

export const projectMemoryMigration: DatabaseMigrationDefinition = {
  name: "PersistProjectRulesAndDecisions",
  up: `
    CREATE TABLE project_memory (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      entries_json TEXT NOT NULL CHECK (
        json_valid(entries_json) AND json_type(entries_json) = 'array'
        AND json_array_length(entries_json) <= 20
        AND length(CAST(entries_json AS BLOB)) <= 24576
      )
    );
    CREATE TABLE conversation_project_memory (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      disabled_ids_json TEXT NOT NULL CHECK (
        json_valid(disabled_ids_json) AND json_type(disabled_ids_json) = 'array'
        AND json_array_length(disabled_ids_json) <= 20
        AND length(disabled_ids_json) <= 1024
      )
    );
  `,
};
