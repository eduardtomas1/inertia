import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CodexThreadToolPackRepository } from "../../src/server/persistence/codex-thread-tool-pack-repository";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  CODEX_THREAD_TOOL_PACKS_SCHEMA_VERSION,
  codexThreadToolPacksMigration,
} from "../../src/server/persistence/migrations/codex-thread-tool-packs";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";

const directories: string[] = [];
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "inertia-codex-thread-packs-"));
  directories.push(created);
  return created;
}

function runMigration(database: Database.Database): void {
  const up = codexThreadToolPacksMigration.up;
  if (typeof up === "string") throw new Error("The Codex thread pack migration is a callback.");
  database.transaction(() => up(database, {
    sourceSchemaVersion: CODEX_THREAD_TOOL_PACKS_SCHEMA_VERSION - 1,
  } as never))();
}

function tableExists(database: Database.Database, type: "table" | "index", name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !== undefined;
}

describe("PersistCodexThreadToolPacks migration", () => {
  it("is schema 109, appended after the task source chat column", () => {
    expect(CODEX_THREAD_TOOL_PACKS_SCHEMA_VERSION).toBe(109);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(CODEX_THREAD_TOOL_PACKS_SCHEMA_VERSION);
    expect(codexThreadToolPacksMigration.name).toBe("PersistCodexThreadToolPacks");
    expect(codexThreadToolPacksMigration.foreignKeys).toBeUndefined();
  });

  it("upgrades a schema 108 database in place, keeps its chats and session ids, and stays idempotent", async () => {
    const root = await directory();
    const databasePath = join(root, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    const project = store.createProject("Codex", root);
    const chat = store.createConversation(project.id, "Resumable", { activate: false });
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec("DROP TABLE codex_thread_tool_packs");
    legacy.prepare("UPDATE conversations SET provider_session_id = ? WHERE id = ?").run("thread-before-upgrade", chat.id);
    legacy.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(CODEX_THREAD_TOOL_PACKS_SCHEMA_VERSION);
    expect(tableExists(legacy, "table", "codex_thread_tool_packs")).toBe(false);
    const before = legacy.prepare("SELECT * FROM conversations ORDER BY id").all();
    legacy.close();

    const upgraded = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    upgraded.close();
    const inspected = new Database(databasePath);
    try {
      expect(inspected.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = ?")
        .get(CODEX_THREAD_TOOL_PACKS_SCHEMA_VERSION)).toEqual({ applied: 1 });
      expect(tableExists(inspected, "table", "codex_thread_tool_packs")).toBe(true);
      expect(tableExists(inspected, "index", "codex_thread_tool_packs_registered_idx")).toBe(true);
      expect(inspected.prepare("SELECT * FROM conversations ORDER BY id").all()).toEqual(before);
      expect(() => runMigration(inspected)).not.toThrow();
      expect(inspected.prepare("PRAGMA integrity_check").pluck().get()).toBe("ok");
    } finally {
      inspected.close();
    }
  });

  it("refuses a table of the same name with another shape", async () => {
    const root = await directory();
    const database = new Database(join(root, "inertia.sqlite"));
    try {
      migrateRuntimeDatabase(database, CODEX_THREAD_TOOL_PACKS_SCHEMA_VERSION - 1);
      database.exec("CREATE TABLE codex_thread_tool_packs (thread_id TEXT PRIMARY KEY, packs TEXT)");
      expect(() => runMigration(database)).toThrow("Unexpected Codex thread tool registration table.");
    } finally {
      database.close();
    }
  });

  it("rejects rows outside the bounds the runtime validates", async () => {
    const root = await directory();
    const store = new RuntimeStore(join(root, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
    store.close();
    const database = new Database(join(root, "inertia.sqlite"));
    try {
      const insert = database.prepare(`
        INSERT INTO codex_thread_tool_packs (thread_id, pack_id, pack_digest, registered_at) VALUES (?, ?, ?, ?)
      `);
      const at = "2026-10-27T09:00:00.000Z";
      expect(() => insert.run("", "inertia.workspace", DIGEST_A, at)).toThrow();
      expect(() => insert.run("x".repeat(513), "inertia.workspace", DIGEST_A, at)).toThrow();
      expect(() => insert.run("thread", "inertia.workspace", "A".repeat(64), at)).toThrow();
      expect(() => insert.run("thread", "inertia.workspace", DIGEST_A.slice(1), at)).toThrow();
      expect(() => insert.run("thread", "inertia.workspace", DIGEST_A, at)).not.toThrow();
      expect(() => insert.run("thread", "inertia.workspace", DIGEST_B, at)).toThrow();
    } finally {
      database.close();
    }
  });
});

describe("Codex thread tool pack records", () => {
  it("keeps a thread's registration across a store reopen, replaces it on a new start, and refuses unsafe ids", async () => {
    const root = await directory();
    const databasePath = join(root, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    store.codexThreadToolPacks.record("thread-1", new Map([["inertia.workspace", DIGEST_A], ["inertia.orchestration", DIGEST_B]]));
    store.codexThreadToolPacks.record("bad\u0000thread", new Map([["inertia.workspace", DIGEST_A]]));
    store.codexThreadToolPacks.record("thread-2", new Map([["Not A Pack", DIGEST_A], ["inertia.workspace", "z".repeat(64)]]));
    store.close();

    const reopened = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    try {
      expect(reopened.codexThreadToolPacks.read("thread-1")).toEqual(new Map([
        ["inertia.orchestration", DIGEST_B],
        ["inertia.workspace", DIGEST_A],
      ]));
      expect(reopened.codexThreadToolPacks.read("bad\u0000thread")).toBeNull();
      expect(reopened.codexThreadToolPacks.read("thread-2")).toBeNull();
      expect(reopened.codexThreadToolPacks.read("unknown")).toBeNull();
      expect(reopened.codexThreadToolPacks.read("x".repeat(513))).toBeNull();

      reopened.codexThreadToolPacks.record("thread-1", new Map([["inertia.workspace", DIGEST_B]]));
      expect(reopened.codexThreadToolPacks.read("thread-1")).toEqual(new Map([["inertia.workspace", DIGEST_B]]));
    } finally {
      reopened.close();
    }
  });

  it("prunes old registrations unless a chat still resumes from their thread", async () => {
    const root = await directory();
    const databasePath = join(root, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, root, { recoverInterruptedRuns: false });
    const project = store.createProject("Codex", root);
    const chat = store.createConversation(project.id, "Resumable", { activate: false });
    store.close();
    const database = new Database(databasePath);
    try {
      database.prepare("UPDATE conversations SET provider_session_id = 'thread-kept' WHERE id = ?").run(chat.id);
      let tick = 0;
      const repository = new CodexThreadToolPackRepository(
        () => database,
        () => new Date(Date.UTC(2026, 9, 27, 0, 0, 0, tick++)).toISOString(),
      );
      const packs = new Map([["inertia.workspace", DIGEST_A]]);
      repository.record("thread-kept", packs);
      repository.record("thread-dropped", packs);
      for (let index = 0; index < 1_024; index += 1) repository.record(`thread-${index}`, packs);
      expect(repository.read("thread-kept")).toEqual(packs);
      expect(repository.read("thread-dropped")).toBeNull();
      expect(repository.read("thread-0")).toEqual(packs);
      expect(database.prepare("SELECT COUNT(DISTINCT thread_id) FROM codex_thread_tool_packs").pluck().get()).toBe(1_025);
    } finally {
      database.close();
    }
  });
});
