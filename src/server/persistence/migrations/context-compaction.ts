import type { DatabaseMigrationDefinition } from "./catalog";

export const contextCompactionMigration: DatabaseMigrationDefinition = {
  name: "PersistContextCompactionReceipts",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(messages)").all() as { name: string; type: string; notnull: number }[];
    const existing = columns.find(({ name }) => name === "compaction_json");
    if (existing) {
      if (existing.type !== "TEXT" || existing.notnull !== 0) throw new Error("Unexpected compaction metadata column.");
      return;
    }
    database.exec(`ALTER TABLE messages ADD COLUMN compaction_json TEXT
      CHECK (compaction_json IS NULL OR (
        role = 'system' AND turn_id IS NULL
        AND length(compaction_json) BETWEEN 1 AND 512 AND json_valid(compaction_json)
      ));`);
  },
};
