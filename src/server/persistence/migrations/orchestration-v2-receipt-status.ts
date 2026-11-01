import type { DatabaseMigrationDefinition } from "./catalog";

export const ORCHESTRATION_V2_RECEIPT_STATUS_SCHEMA_VERSION = 113;

export const orchestrationV2ReceiptStatusMigration: DatabaseMigrationDefinition = {
  name: "OrchestrationV2ReceiptStatusAndProjectionMetadata",
  up: (database) => {
    const columns = new Set((database.prepare("PRAGMA table_info(orchestration_v2_receipts)")
      .all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("status")) {
      database.exec(`
        ALTER TABLE orchestration_v2_receipts
          ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'
          CHECK (status IN ('accepted', 'rejected'));
      `);
    }
    if (!columns.has("error")) {
      database.exec(`
        ALTER TABLE orchestration_v2_receipts
          ADD COLUMN error TEXT CHECK (error IS NULL OR length(error) <= 1000);
      `);
    }
    if (!columns.has("command_type")) {
      database.exec(`
        ALTER TABLE orchestration_v2_receipts
          ADD COLUMN command_type TEXT CHECK (command_type IS NULL OR length(command_type) <= 240);
      `);
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_v2_projection_metadata (
        projection_name TEXT PRIMARY KEY CHECK (projection_name = 'orchestration-v2'),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO orchestration_v2_projection_metadata
        (projection_name, schema_version, last_sequence, updated_at)
      SELECT 'orchestration-v2', 1, COALESCE(MAX(sequence), 0), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM orchestration_v2_events;
    `);
  },
};
