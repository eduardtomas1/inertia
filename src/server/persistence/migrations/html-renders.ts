import type { DatabaseMigrationDefinition } from "./catalog";

// The message check deliberately does not require turn_id: messages.turn_id is
// ON DELETE SET NULL, and a conversation delete may null it before the cascade
// removes the message. Turn scope is enforced on write and on projection.
export const htmlRendersMigration: DatabaseMigrationDefinition = {
  name: "PersistHtmlRenders",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(messages)").all() as { name: string; type: string; notnull: number }[];
    const existing = columns.find(({ name }) => name === "html_render_json");
    if (existing && (existing.type !== "TEXT" || existing.notnull !== 0)) {
      throw new Error("Unexpected rendered page metadata column.");
    }
    if (!existing) {
      database.exec(`ALTER TABLE messages ADD COLUMN html_render_json TEXT
        CHECK (html_render_json IS NULL OR (
          role = 'system'
          AND length(html_render_json) BETWEEN 1 AND 1024 AND json_valid(html_render_json)
        ));`);
    }
    database.exec(`CREATE TABLE IF NOT EXISTS html_renders (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
      html TEXT NOT NULL CHECK (length(CAST(html AS BLOB)) BETWEEN 1 AND 262144),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS html_renders_conversation_idx ON html_renders(conversation_id);`);
  },
};
