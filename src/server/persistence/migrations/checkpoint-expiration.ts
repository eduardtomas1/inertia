import type { DatabaseMigrationDefinition } from "./catalog";

export const CHECKPOINT_EXPIRATION_SCHEMA_VERSION = 120;

export const checkpointExpirationMigration: DatabaseMigrationDefinition = {
  name: "RecordCheckpointExpiration",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(checkpoints)")
      .all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "expired_at")) {
      database.exec("ALTER TABLE checkpoints ADD COLUMN expired_at TEXT;");
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS checkpoints_active_conversation_idx
        ON checkpoints(conversation_id, created_at DESC, id DESC)
        WHERE expired_at IS NULL;
    `);
  },
};
