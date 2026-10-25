import type { DatabaseMigrationDefinition } from "./catalog";

export const watcherAccessMigration: DatabaseMigrationDefinition = {
  name: "PersistWatcherAccess",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(watcher_links)")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const existing = columns.find((column) => column.name === "read_only");
    if (existing && (existing.type !== "INTEGER" || existing.notnull !== 1 || existing.dflt_value !== "1")) {
      throw new Error("Unexpected watcher access column.");
    }
    if (!existing) {
      database.exec(`
        ALTER TABLE watcher_links ADD COLUMN read_only INTEGER NOT NULL DEFAULT 1
          CHECK (read_only IN (0, 1));
      `);
    }
  },
};
