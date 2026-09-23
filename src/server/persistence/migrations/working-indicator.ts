import type { DatabaseMigrationDefinition } from "./catalog";

export const workingIndicatorMigration: DatabaseMigrationDefinition = {
  name: "PersistWorkingIndicator",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "working_indicator_json")) {
      return;
    }
    database.exec(`
      ALTER TABLE app_state
        ADD COLUMN working_indicator_json TEXT NOT NULL DEFAULT '{}'
        CHECK (length(working_indicator_json) <= 512);
    `);
  },
};
