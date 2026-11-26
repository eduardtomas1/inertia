import type Database from "better-sqlite3";

import { migrateRuntimeDatabase, runtimeMigrationCatalog } from "../../src/server/persistence/migrations/runtime-catalog";

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
 * Main's last release before each main sync, which orchestrator-v2 builds of
 * that time numbered their own migrations after: 111 before the 92e23166 sync
 * (branch migrations recorded as 112 to 118), 116 before the e37ff42b sync
 * (recorded as 117 to 123), and 119 before the 29fb5e78 sync (recorded as
 * 120 to 126).
 */
export const PRE_MERGE_MAIN_SCHEMAS = { "92e23166": 111, e37ff42b: 116, d290381c: 119 } as const;
export type PreMergeSync = keyof typeof PRE_MERGE_MAIN_SCHEMAS;

/**
 * Builds the schema an orchestrator-v2 build from before the given main sync
 * left behind: main's migrations through that sync's base, then the branch's
 * seven numbered directly after it, without main's migrations released under
 * those numbers since.
 */
export function simulatePreMergeOrchestratorV2Database(
  database: Database.Database,
  sync: PreMergeSync = "92e23166",
): void {
  const mainSchema = PRE_MERGE_MAIN_SCHEMAS[sync];
  migrateRuntimeDatabase(database, mainSchema);
  const catalog = runtimeMigrationCatalog();
  database.pragma("foreign_keys = OFF");
  database.transaction(() => {
    BRANCH_MIGRATIONS.forEach((name, index) => {
      const migration = catalog.find((entry) => entry.name === name);
      if (!migration) throw new Error(`Missing branch migration ${name}.`);
      if (typeof migration.up === "string") database.exec(migration.up);
      else migration.up(database, { sourceSchemaVersion: mainSchema, sourceReleases: [], setLegacyBackfillDiagnostics: () => undefined });
      const appliedAt = sync === "92e23166"
        ? "2026-11-08T12:00:00.000Z"
        : sync === "e37ff42b"
          ? "2026-11-20T12:00:00.000Z"
          : "2026-11-22T12:00:00.000Z";
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(mainSchema + 1 + index, appliedAt);
    });
  })();
  database.pragma("foreign_keys = ON");
}
