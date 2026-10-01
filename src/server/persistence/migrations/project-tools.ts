import type { DatabaseMigrationDefinition } from "./catalog";

export const projectToolsMigration: DatabaseMigrationDefinition = {
  name: "PersistProjectToolConnections",
  up: `CREATE TABLE project_tools (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    config_json TEXT NOT NULL CHECK (length(config_json) <= 4096)
  ); CREATE INDEX project_tools_project_idx ON project_tools(project_id);`,
};
