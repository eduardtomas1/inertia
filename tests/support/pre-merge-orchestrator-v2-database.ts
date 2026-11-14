import type Database from "better-sqlite3";

import { migrateRuntimeDatabase, runtimeMigrationCatalog } from "../../src/server/persistence/migrations/runtime-catalog";

/** Main's last release before the 92e23166 sync, which orchestrator-v2 then numbered its own migrations after. */
const PRE_MERGE_MAIN_SCHEMA = 111;
const BRANCH_MIGRATIONS = [
  "OrchestrationV2EventStore",
  "SupportNativePiProvider",
  "SupportCursorSdkHarness",
  "RaiseConversationContextSupplementBound",
  "PersistDelegatedTasks",
  "PersistDelegationAutomaticWakes",
  "OrchestrationV2ReceiptStatusAndProjectionMetadata",
] as const;

/**
 * Builds the schema an orchestrator-v2 build from before the 92e23166 main
 * sync left behind: main's migrations through 111, then the branch's seven
 * recorded as 112 to 118, without main's later 112 to 116.
 */
export function simulatePreMergeOrchestratorV2Database(database: Database.Database): void {
  migrateRuntimeDatabase(database, PRE_MERGE_MAIN_SCHEMA);
  const catalog = runtimeMigrationCatalog();
  database.pragma("foreign_keys = OFF");
  database.transaction(() => {
    BRANCH_MIGRATIONS.forEach((name, index) => {
      const migration = catalog.find((entry) => entry.name === name);
      if (!migration) throw new Error(`Missing branch migration ${name}.`);
      if (typeof migration.up === "string") database.exec(migration.up);
      else migration.up(database, { sourceSchemaVersion: PRE_MERGE_MAIN_SCHEMA, sourceReleases: [], setLegacyBackfillDiagnostics: () => undefined });
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(PRE_MERGE_MAIN_SCHEMA + 1 + index, "2026-11-08T12:00:00.000Z");
    });
  })();
  database.pragma("foreign_keys = ON");
}
