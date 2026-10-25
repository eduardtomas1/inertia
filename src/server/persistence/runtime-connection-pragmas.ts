import type Database from "better-sqlite3";

export function applyRuntimeConnectionPragmas(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("cache_size = -16000");
  database.pragma("mmap_size = 268435456");
  database.pragma("temp_store = MEMORY");
}

export function optimizeRuntimeConnection(database: Database.Database, mask?: number): void {
  if (!database.open || database.readonly || database.inTransaction) return;
  if (database.pragma("query_only", { simple: true }) !== 0) return;
  try {
    database.pragma("analysis_limit = 1000");
    database.pragma(mask === undefined ? "optimize" : `optimize = ${mask}`);
  } catch {
    return;
  }
}

export function openRuntimeConnection(
  database: Database.Database,
  migrate: (database: Database.Database) => void,
): void {
  applyRuntimeConnectionPragmas(database);
  migrate(database);
  optimizeRuntimeConnection(database, 0x10002);
}

export function closeRuntimeConnection(database: Database.Database): void {
  optimizeRuntimeConnection(database);
  if (database.open) database.close();
}
