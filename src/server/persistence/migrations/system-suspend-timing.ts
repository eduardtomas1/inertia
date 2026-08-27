import type { DatabaseMigrationDefinition } from "./catalog";

export const persistSuspendAwareTurnTiming: DatabaseMigrationDefinition = {
  name: "PersistSuspendAwareTurnTiming",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(agent_turns)")
      .all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "suspended_duration_ms")) {
      database.exec(`
        ALTER TABLE agent_turns
          ADD COLUMN suspended_duration_ms INTEGER NOT NULL DEFAULT 0
          CHECK (
            suspended_duration_ms >= 0
            AND suspended_duration_ms <= 9007199254740991
          );
      `);
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS system_suspend_intervals (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE
          CHECK (length(id) = 36),
        suspended_at TEXT NOT NULL
          CHECK (length(suspended_at) BETWEEN 20 AND 40),
        resumed_at TEXT NOT NULL
          CHECK (length(resumed_at) BETWEEN 20 AND 40),
        CHECK (resumed_at >= suspended_at)
      );

      CREATE INDEX IF NOT EXISTS system_suspend_intervals_range_idx
      ON system_suspend_intervals(suspended_at ASC, resumed_at ASC);
    `);
  },
};
