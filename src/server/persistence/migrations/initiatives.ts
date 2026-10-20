import type { DatabaseMigrationDefinition } from "./catalog";

/**
 * Initiatives group chats across projects. The brief, its revision and the
 * preferences document are created now, unused, so later phases can adopt
 * them without another conversations-adjacent table rebuild.
 *
 * The CHECKs mirror `src/shared/initiatives.ts` exactly: names count
 * characters (code points) and may not start or end with a space, since
 * SQLite `trim()` strips only spaces; the brief counts UTF-8 bytes.
 */
export const initiativesMigration: DatabaseMigrationDefinition = {
  name: "PersistInitiatives",
  up: (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS initiatives (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        name TEXT NOT NULL
          CHECK (
            length(name) BETWEEN 1 AND 120
            AND name = trim(name)
            AND instr(name, char(0)) = 0
            AND instr(name, char(9)) = 0
            AND instr(name, char(10)) = 0
            AND instr(name, char(13)) = 0
          ),
        color TEXT NOT NULL
          CHECK (color IN ('red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink')),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'done', 'archived')),
        brief TEXT NOT NULL DEFAULT ''
          CHECK (length(CAST(brief AS BLOB)) <= 8192 AND instr(brief, char(0)) = 0),
        brief_revision INTEGER NOT NULL DEFAULT 0 CHECK (brief_revision >= 0),
        preferences_json TEXT NOT NULL DEFAULT '{}'
          CHECK (length(preferences_json) <= 65536),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
        updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
      );
      CREATE TRIGGER IF NOT EXISTS initiatives_count_limit
        BEFORE INSERT ON initiatives
        WHEN (SELECT COUNT(*) FROM initiatives) >= 100
        BEGIN
          SELECT RAISE(ABORT, 'initiative count limit exceeded');
        END;
    `);
    const columns = database.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "initiative_id")) {
      database.exec(`
        ALTER TABLE conversations ADD COLUMN initiative_id TEXT
          REFERENCES initiatives(id) ON DELETE SET NULL
          CHECK (initiative_id IS NULL OR length(initiative_id) = 36);
      `);
    }
    database.exec(`CREATE INDEX IF NOT EXISTS conversations_initiative_idx
      ON conversations(initiative_id);`);
  },
};
