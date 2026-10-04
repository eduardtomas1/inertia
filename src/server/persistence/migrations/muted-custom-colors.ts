import type { DatabaseMigrationDefinition } from "./catalog";

export const mutedCustomColorsMigration: DatabaseMigrationDefinition = {
  name: "PersistMutedCustomColors",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "muted_custom_colors")) return;
    database.exec(`
      ALTER TABLE app_state
        ADD COLUMN muted_custom_colors INTEGER NOT NULL DEFAULT 0
        CHECK (muted_custom_colors IN (0, 1));
    `);
  },
};
