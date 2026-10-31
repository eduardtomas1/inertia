import type { DatabaseMigrationDefinition } from "./catalog";

export const CODEX_THREAD_TOOL_PACKS_SCHEMA_VERSION = 109;

const EXPECTED_COLUMNS = ["thread_id", "pack_id", "pack_digest", "registered_at"];

/**
 * Records the capability packs each Codex thread registered at `thread/start`,
 * keyed by the same thread identifier Inertia stores as the chat's provider
 * session. Codex keeps a thread's dynamic tools for its lifetime and accepts
 * no registration on resume, so this record decides which pack instructions a
 * resumed thread can honour after the runtime restarts.
 */
export const codexThreadToolPacksMigration: DatabaseMigrationDefinition = {
  name: "PersistCodexThreadToolPacks",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(codex_thread_tool_packs)")
      .all() as Array<{ name: string }>;
    if (
      columns.length > 0
      && columns.map(({ name }) => name).join(",") !== EXPECTED_COLUMNS.join(",")
    ) {
      throw new Error("Unexpected Codex thread tool registration table.");
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS codex_thread_tool_packs (
        thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 512),
        pack_id TEXT NOT NULL CHECK (length(pack_id) BETWEEN 1 AND 64),
        pack_digest TEXT NOT NULL CHECK (
          length(pack_digest) = 64 AND pack_digest NOT GLOB '*[^0-9a-f]*'
        ),
        registered_at TEXT NOT NULL CHECK (length(registered_at) BETWEEN 20 AND 40),
        PRIMARY KEY (thread_id, pack_id)
      );
      CREATE INDEX IF NOT EXISTS codex_thread_tool_packs_registered_idx
        ON codex_thread_tool_packs(registered_at, thread_id);
    `);
  },
};
