import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

import {
  backfillLegacyAgentTurns,
  backfillLegacyAgentTurnsBounded,
  formatMigrationDiagnostic,
  runDatabaseMigrations,
  type DatabaseMigrationDiagnostic,
  type LegacyBackfillDiagnostics,
} from "../../../src/server/persistence/migrations/runner.ts";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../../src/server/persistence/migrations/runtime-catalog.ts";

const ACTIVITY_COUNT = 150_000;
const DUMPED_TABLES = [
  ["agent_turns", "id"],
  ["messages", "id"],
  ["activities", "id"],
  ["agent_reasonings", "id"],
  ["checkpoints", "id"],
  ["agent_plans", "conversation_id"],
  ["thread_usage", "conversation_id"],
  ["workspace_runs", "id"],
] as const;

function open(image: Buffer): Database.Database {
  const database = new Database(image);
  database.pragma("foreign_keys = ON");
  return database;
}

function digest(database: Database.Database): string {
  const hash = createHash("sha256");
  for (const [table, key] of DUMPED_TABLES) {
    for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).iterate()) {
      hash.update(JSON.stringify([table, row]));
    }
  }
  return hash.digest("hex");
}

function count(database: Database.Database, sql: string): number {
  return (database.prepare(sql).get() as { n: number }).n;
}

function state(database: Database.Database): Record<string, unknown> {
  return {
    schemaVersion: count(database, "SELECT MAX(version) AS n FROM schema_migrations"),
    activities: count(database, "SELECT COUNT(*) AS n FROM activities"),
    ownedActivities: count(database, "SELECT COUNT(*) AS n FROM activities WHERE turn_id IS NOT NULL"),
    agentTurns: count(database, "SELECT COUNT(*) AS n FROM agent_turns"),
    foreignKeyErrors: database.pragma("foreign_key_check"),
    integrity: database.pragma("integrity_check", { simple: true }),
  };
}

function reproductionImage(): Buffer {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    migrateRuntimeDatabase(database, 17);
    database.exec(`
      INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
        VALUES ('p', 'Synthetic legacy project', '/synthetic', '#888888', 'ready', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      INSERT INTO conversations (id, project_id, title, created_at, updated_at)
        VALUES ('c', 'p', 'Synthetic legacy conversation', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      INSERT INTO messages (id, conversation_id, role, content, created_at)
        VALUES ('u', 'c', 'user', 'Synthetic request', '2025-01-01T00:00:00.000Z');
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ${ACTIVITY_COUNT})
      INSERT INTO activities (id, conversation_id, run_id, kind, title, status, created_at)
        SELECT 'a-' || n, 'c', 'legacy-run', 'status', 'Synthetic event', 'completed', '2025-01-01T00:00:01.000Z' FROM numbers;
    `);
    return database.serialize();
  } finally {
    database.close();
  }
}

function releasedWithEnlargedStack(image: Buffer): Promise<{ diagnostics: LegacyBackfillDiagnostics; image: Uint8Array }> {
  return new Promise((settle, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { image },
      resourceLimits: { stackSizeMb: 64 },
    });
    worker.once("message", settle);
    worker.once("error", reject);
  });
}

if (!isMainThread) {
  const database = open(Buffer.from((workerData as { image: Uint8Array }).image));
  const diagnostics = backfillLegacyAgentTurns(database, { sourceSchemaVersion: 17 });
  parentPort!.postMessage({ diagnostics, image: database.serialize() });
  database.close();
} else {
  const image = reproductionImage();

  const failing = open(image);
  let failure: unknown = null;
  try {
    backfillLegacyAgentTurns(failing, { sourceSchemaVersion: 17 });
  } catch (error) {
    failure = error;
  }
  const failureState = state(failing);
  failing.close();

  const released = await releasedWithEnlargedStack(image);
  const releasedDatabase = open(Buffer.from(released.image));
  const releasedDigest = digest(releasedDatabase);
  releasedDatabase.close();
  const bounded = open(image);
  const boundedDiagnostics = backfillLegacyAgentTurnsBounded(bounded, { sourceSchemaVersion: 17 });
  const boundedDigest = digest(bounded);
  bounded.close();

  const upgrading = open(image);
  let diagnostic: DatabaseMigrationDiagnostic | null = null;
  const startedAt = performance.now();
  runDatabaseMigrations(upgrading, runtimeMigrationCatalog(), { onDiagnostic: (value) => { diagnostic = value; } });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const upgradedState = state(upgrading);
  const turn = upgrading.prepare(`
    SELECT run_id, user_message_id, requested_at, started_at, completed_at, status, association FROM agent_turns
  `).get();
  upgrading.close();

  console.log(JSON.stringify({
    issue: 368,
    baseline: execFileSync("git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" }).trim(),
    reproduce: "npx --no-install esbuild docs/pr-evidence/legacy-368/legacy-backfill-evidence.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/legacy-backfill-evidence.mjs --banner:js='import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);' && node node_modules/.cache/legacy-backfill-evidence.mjs",
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    fixture: `In-memory schema 17 with one synthetic user request and ${ACTIVITY_COUNT.toLocaleString("en-US")} completed activities for one run`,
    failure: {
      path: "Released backfillLegacyAgentTurns at the default stack",
      error: failure instanceof Error ? { name: failure.name, message: failure.message } : null,
      stateAfterRollback: failureState,
    },
    equivalence: {
      released: {
        path: "Released backfillLegacyAgentTurns in a Worker with a 64 MB stack",
        digest: releasedDigest,
        diagnostics: released.diagnostics,
      },
      bounded: {
        path: "backfillLegacyAgentTurnsBounded at the default stack",
        digest: boundedDigest,
        diagnostics: boundedDiagnostics,
      },
      identical: releasedDigest === boundedDigest
        && JSON.stringify(released.diagnostics) === JSON.stringify(boundedDiagnostics),
    },
    success: {
      path: "runDatabaseMigrations over the full runtime catalog at the default stack",
      diagnostic: formatMigrationDiagnostic(diagnostic!),
      compatibility: (diagnostic as DatabaseMigrationDiagnostic | null)?.compatibility ?? null,
      elapsedMs,
      evidenceProcessPeakResidentSetMb: Math.round(process.resourceUsage().maxRSS / 1024),
      turn,
      state: upgradedState,
    },
  }, null, 2));
}
