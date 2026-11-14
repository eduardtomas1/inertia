import { lstatSync } from "node:fs";

import Database from "better-sqlite3";

import { RuntimeStartupBlockerError } from "../../shared/runtime-startup-diagnostics";

/**
 * Orchestrator-v2 development builds made before the 92e23166 main sync
 * recorded their own migrations as 107 to 118. Main has since released
 * different migrations under those numbers, so such a database would skip
 * main's migrations and fail later. Its event store exists while main's
 * PersistCustomAgents (115) table does not, a state no released numbering
 * can produce, since the event store migration now runs after 115.
 */
const LAST_PRE_MERGE_BRANCH_VERSION = 118;

export const ORCHESTRATOR_V2_DEVELOPMENT_DATABASE_MESSAGE =
  "This database was created by an earlier orchestrator-v2 development build and must be reset.";

function hasTable(database: Database.Database, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export function preMergeOrchestratorV2Database(database: Database.Database): boolean {
  if (!hasTable(database, "orchestration_v2_events") || hasTable(database, "custom_agents")) return false;
  if (!hasTable(database, "schema_migrations")) return false;
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
