import type { DatabaseMigrationDefinition } from "./catalog";

export const completionSoundMigration: DatabaseMigrationDefinition = {
  name: "PersistCompletionSound",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "completion_sound_json")) {
      return;
    }
    database.exec(`
      ALTER TABLE app_state
        ADD COLUMN completion_sound_json TEXT NOT NULL DEFAULT '{}'
        CHECK (length(completion_sound_json) <= 2048);
    `);
  },
};
