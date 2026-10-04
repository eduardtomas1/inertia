import type { DatabaseMigrationDefinition } from "./catalog";

export const notificationPreferencesMigration: DatabaseMigrationDefinition = {
  name: "PersistNotificationPreferences",
  up: (database) => {
    const existing = new Set((database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>).map(({ name }) => name));
    if (!existing.has("quota_warnings_enabled")) {
      database.exec(`
        ALTER TABLE app_state
          ADD COLUMN quota_warnings_enabled INTEGER NOT NULL DEFAULT 1
          CHECK (quota_warnings_enabled IN (0, 1));
      `);
    }
    if (!existing.has("quota_warning_threshold")) {
      database.exec(`
        ALTER TABLE app_state
          ADD COLUMN quota_warning_threshold INTEGER NOT NULL DEFAULT 25
          CHECK (quota_warning_threshold IN (5, 15, 25));
      `);
    }
    if (!existing.has("notify_only_in_background")) {
      database.exec(`
        ALTER TABLE app_state
          ADD COLUMN notify_only_in_background INTEGER NOT NULL DEFAULT 0
          CHECK (notify_only_in_background IN (0, 1));
      `);
    }
  },
};
