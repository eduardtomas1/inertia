import { lstatSync } from "node:fs";

import Database from "better-sqlite3";

import { RuntimeStartupBlockerError } from "../../shared/runtime-startup-diagnostics";

/**
 * Orchestrator-v2 development builds recorded their own migrations under
 * numbers main later released for different migrations: builds from before
 * the 92e23166 main sync as 107 to 118, and builds from before the e37ff42b
 * sync as 117 to 123. Such a database would skip main's migrations under
 * those numbers and fail later. Both leave the event store without main's
 * PersistSentToUserMessages (118) column, a state no released numbering can
 * produce, since the event store migration now runs after 118.
 */
const LAST_PRE_MERGE_BRANCH_VERSION = 123;

export const ORCHESTRATOR_V2_DEVELOPMENT_DATABASE_MESSAGE =
  "This database was created by an earlier orchestrator-v2 development build and must be reset.";

function hasTable(database: Database.Database, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  return database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== undefined;
}

export function preMergeOrchestratorV2Database(database: Database.Database): boolean {
  if (!hasTable(database, "orchestration_v2_events") || !hasTable(database, "schema_migrations")) return false;
  if (!hasTable(database, "messages") || hasColumn(database, "messages", "sent_to_user")) return false;
  const latest = database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get() as number | null;
  return latest !== null && latest <= LAST_PRE_MERGE_BRANCH_VERSION;
}

/** Refuses such a database before startup recovery or migrations touch it. */
export function assertNotPreMergeOrchestratorV2Database(databasePath: string): void {
  try {
    if (!lstatSync(databasePath).isFile()) return;
  } catch {
    return;
  }
  let database: Database.Database | null = null;
  let renumbered = false;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    renumbered = preMergeOrchestratorV2Database(database);
  } catch {
    // Unreadable or corrupt files belong to the existing startup recovery.
    return;
  } finally {
    if (database?.open) database.close();
  }
  if (renumbered) {
    throw new RuntimeStartupBlockerError("orchestrator-v2-development-database", ORCHESTRATOR_V2_DEVELOPMENT_DATABASE_MESSAGE);
  }
}
