import type Database from "better-sqlite3";

/** Remove later schema additions when reconstructing a pre-72 database. */
export function removeProjectSettingsFromLegacyFixture(database: Database.Database): void {
  database.exec(`
    DROP TABLE IF EXISTS queued_messages;
    ALTER TABLE projects DROP COLUMN preferences_json;
    ALTER TABLE conversations DROP COLUMN marked_unread_at;
    ALTER TABLE app_state DROP COLUMN light_color_theme;
    ALTER TABLE app_state DROP COLUMN dark_color_theme;
    DELETE FROM schema_migrations WHERE version >= 72;
  `);
}
