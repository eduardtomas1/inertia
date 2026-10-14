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
