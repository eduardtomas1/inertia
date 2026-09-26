import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function schema81Database(): Promise<{ databasePath: string; workspacePath: string; turnId: string }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-target-ownership-"));
  directories.push(directory);
  const databasePath = join(directory, "published.sqlite");
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  await copyFile(fixture, databasePath);
  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    migrateRuntimeDatabase(database, 81);
    const { turnId } = database.prepare(
      "SELECT id AS turnId FROM agent_turns WHERE conversation_id = ? ORDER BY requested_at, id LIMIT 1",
    ).get("fixture-conversation-006") as { turnId: string };
    database.prepare(`
      INSERT INTO agent_thread_operations (
        id, source_conversation_id, source_turn_id, source_run_id, tool_call_id_hash, tool_name,
        request_fingerprint, status, child_conversation_id, input_chars, created_at, updated_at
      ) VALUES (?, ?, ?, 'legacy-run', ?, 'inertia_create_conversation', ?, 'completed', ?, 12, ?, ?)
    `).run("a".repeat(64), "fixture-conversation-006", turnId, "b".repeat(64), "c".repeat(64),
      "fixture-conversation-006", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
    return { databasePath, workspacePath, turnId };
  } finally {
    database.close();
  }
}

describe("managed turn ownership migration", () => {
  it("upgrades a schema-81 database without inventing cancellation authority for legacy operations", async () => {
    const { databasePath, workspacePath, turnId } = await schema81Database();
    const legacy = new Database(databasePath, { readonly: true });
    expect((legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version).toBe(81);
    legacy.close();

    const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    try {
      expect(store.agentThreadManagement.runsDispatchedByTurn("fixture-conversation-006", turnId)).toEqual([]);
    } finally {
      store.close();
    }

    const migrated = new Database(databasePath);
    try {
      expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(82);
      expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version >= 81 ORDER BY version").all())
        .toEqual([{ version: 81 }, { version: 82 }]);
      expect(migrated.prepare(
        "SELECT child_conversation_id, status, target_turn_id, target_run_id FROM agent_thread_operations",
      ).all()).toEqual([{
        child_conversation_id: "fixture-conversation-006", status: "completed",
        target_turn_id: null, target_run_id: null,
      }]);
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
      expect(() => migrated.prepare("UPDATE agent_thread_operations SET target_turn_id = ?").run("t".repeat(257)))
        .toThrow(/CHECK constraint failed/u);
      migrated.prepare("UPDATE agent_thread_operations SET target_turn_id = ?, target_run_id = ?").run(turnId, "run-A");
    } finally {
      migrated.close();
    }

    const reopened = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    try {
      expect(reopened.agentThreadManagement.runsDispatchedByTurn("fixture-conversation-006", turnId)).toEqual([{
        conversationId: "fixture-conversation-006", turnId, runId: "run-A",
      }]);
    } finally {
      reopened.close();
    }
  });
});
