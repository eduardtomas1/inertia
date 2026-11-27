import { lstatSync } from "node:fs";

import Database from "better-sqlite3";

import { RuntimeStartupBlockerError } from "../../shared/runtime-startup-diagnostics";

/**
 * Orchestrator-v2 development builds recorded their own migrations under
 * numbers main later released for different migrations: builds from before
 * the 92e23166 main sync as 107 to 118, builds from before the e37ff42b sync
 * as 117 to 123, builds from before the 29fb5e78 (v0.0.85) sync as 120 to
 * 126, and builds from before the 22bb7578 (PR #782 Antigravity ACP) sync as
 * 123 to 130. Such a database would skip main's migrations under those numbers
 * and fail later. All leave the event store without main's
 * IndexMessageSearchText (122) table and/or SupportNativeAntigravityAcpHarness
 * (123) harness constraint, a state no released numbering can produce, since
 * the event store migration now runs at 124.
 */
const LAST_PRE_MERGE_BRANCH_VERSION = 130;

export const ORCHESTRATOR_V2_DEVELOPMENT_DATABASE_MESSAGE =
  "This database was created by an earlier orchestrator-v2 development build and must be reset.";

function hasTable(database: Database.Database, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function tableSqlIncludes(database: Database.Database, table: string, token: string): boolean {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string | null } | undefined;
  return typeof row?.sql === "string" && row.sql.includes(token);
}

export function preMergeOrchestratorV2Database(database: Database.Database): boolean {
  if (!hasTable(database, "orchestration_v2_events") || !hasTable(database, "schema_migrations")) return false;
  if (
    hasTable(database, "message_search_documents")
    && tableSqlIncludes(database, "model_backend_profiles", "'antigravity-acp'")
  ) {
    return false;
  }
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
