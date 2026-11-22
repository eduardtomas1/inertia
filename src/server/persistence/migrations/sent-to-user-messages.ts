import type { DatabaseMigrationDefinition } from "./catalog";

export const SENT_TO_USER_MESSAGES_SCHEMA_VERSION = 118;

// Like html_render_json, the check does not require turn_id: messages.turn_id
// is ON DELETE SET NULL, and a conversation delete may null it before the
// cascade removes the message. Turn scope is enforced on write and projection.
export const sentToUserMessagesMigration: DatabaseMigrationDefinition = {
  name: "PersistSentToUserMessages",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const existing = columns.find(({ name }) => name === "sent_to_user");
    if (existing && (existing.type !== "INTEGER" || existing.notnull !== 1)) {
      throw new Error("Unexpected sent-to-user message column.");
    }
    if (!existing) {
      database.exec(`ALTER TABLE messages ADD COLUMN sent_to_user INTEGER NOT NULL DEFAULT 0
        CHECK (sent_to_user IN (0, 1) AND (sent_to_user = 0 OR role = 'system'));`);
    }
  },
};
