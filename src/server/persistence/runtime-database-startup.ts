import type Database from "better-sqlite3";
import { migrateRuntimeDatabase } from "./migrations/runtime-catalog";

/** Establish storage durability and migrate before any repository initialization. */
export function initializeRuntimeDatabase(database: Database.Database, initialize: () => void): void {
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
    // NORMAL keeps committed transactions crash-consistent in WAL mode.
    // Power loss can still lose the newest OS-buffered commits.
    database.pragma("synchronous = NORMAL");
    database.pragma("cache_size = -16000");
    database.pragma("mmap_size = 268435456");
    database.pragma("temp_store = MEMORY");
    migrateRuntimeDatabase(database);
    initialize();
  } catch (error) {
    if (database.open) database.close();
    throw error;
  }
}
