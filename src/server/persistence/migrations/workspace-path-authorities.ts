import type { DatabaseMigrationDefinition } from "./catalog";

export const workspacePathAuthoritiesMigration = {
  name: "PersistWorkspacePathAuthorities",
  up: `
    CREATE TABLE IF NOT EXISTS project_path_authorities (
      project_id TEXT PRIMARY KEY
        REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL
        CHECK (length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
      receipt_json TEXT NOT NULL
        CHECK (length(CAST(receipt_json AS BLOB)) BETWEEN 1 AND 20480)
    );
    CREATE TABLE IF NOT EXISTS conversation_path_authorities (
      conversation_id TEXT PRIMARY KEY
        REFERENCES conversations(id) ON DELETE CASCADE,
      path TEXT NOT NULL
        CHECK (length(CAST(path AS BLOB)) BETWEEN 1 AND 4096),
      receipt_json TEXT NOT NULL
        CHECK (length(CAST(receipt_json AS BLOB)) BETWEEN 1 AND 20480)
    );
    CREATE TABLE IF NOT EXISTS workspace_path_authority_enrollment (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      completed INTEGER NOT NULL CHECK (completed IN (0, 1))
    );
    INSERT OR IGNORE INTO workspace_path_authority_enrollment (id, completed)
    VALUES (1, 0);
  `,
} satisfies DatabaseMigrationDefinition;
