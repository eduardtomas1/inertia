import type { DatabaseMigrationDefinition } from "./catalog";

export const scratchProjectMigration: DatabaseMigrationDefinition = {
  name: "PersistScratchProject",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "workspace_kind")) {
      database.exec(`
        ALTER TABLE projects ADD COLUMN workspace_kind TEXT
          CHECK (workspace_kind IS NULL OR workspace_kind = 'scratch');
      `);
    }
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS projects_scratch_workspace
      ON projects(workspace_kind) WHERE workspace_kind = 'scratch';`);
  },
};
