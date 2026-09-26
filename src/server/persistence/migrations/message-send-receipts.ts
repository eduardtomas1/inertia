import type { DatabaseMigrationDefinition } from "./catalog";

export const messageSendReceiptsMigration: DatabaseMigrationDefinition = {
  name: "PersistTextMessageDeliveryReceipts",
  up: `
    CREATE TABLE message_send_receipts (
      request_id TEXT PRIMARY KEY CHECK (length(request_id) = 36),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
      status TEXT NOT NULL CHECK (status IN ('dispatching', 'accepted', 'rejected', 'uncertain')),
      response_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX message_send_receipts_conversation_idx ON message_send_receipts(conversation_id);
  `,
};
