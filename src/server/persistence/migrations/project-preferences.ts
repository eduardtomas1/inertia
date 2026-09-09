import type { DatabaseMigrationDefinition } from "./catalog";

export const projectPreferencesMigration: DatabaseMigrationDefinition = {
  name: "ProjectPreferencesAndExplicitUnreadThreads",
  up: `
    ALTER TABLE projects ADD COLUMN preferences_json TEXT
      CHECK (preferences_json IS NULL OR length(preferences_json) <= 262144);
    ALTER TABLE conversations ADD COLUMN marked_unread_at TEXT;
  `,
};
