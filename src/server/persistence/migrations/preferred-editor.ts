import type { DatabaseMigrationDefinition } from "./catalog";

export const PREFERRED_EDITOR_SCHEMA_VERSION = 121;

export const preferredEditorMigration: DatabaseMigrationDefinition = {
  name: "PersistPreferredEditor",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "preferred_editor")) return;
    database.exec(`
      ALTER TABLE app_state
        ADD COLUMN preferred_editor TEXT NOT NULL DEFAULT 'system'
        CHECK (length(preferred_editor) BETWEEN 1 AND 64);
    `);
  },
};
