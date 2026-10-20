import { randomUUID } from "node:crypto";
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

type ConversationSnapshotRow = {
  id: string;
  project_id: string;
  title: string;
  worktree_path: string | null;
  provider_session_id: string | null;
  updated_at: string;
};

const conversationRows = (database: Database.Database): ConversationSnapshotRow[] => database.prepare(`
  SELECT id, project_id, title, worktree_path, provider_session_id, updated_at
  FROM conversations ORDER BY id
`).all() as ConversationSnapshotRow[];

async function schema98Database(prepare?: (database: Database.Database) => void) {
  const directory = await mkdtemp(join(tmpdir(), "inertia-initiatives-migration-"));
  directories.push(directory);
  const databasePath = join(directory, "published.sqlite");
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  await copyFile(fixture, databasePath);
  const database = new Database(databasePath);
  try {
    migrateRuntimeDatabase(database, 98);
    prepare?.(database);
    return { databasePath, workspacePath, conversations: conversationRows(database) };
  } finally {
    database.close();
  }
}

describe("initiatives migration", () => {
  it("upgrades a published database at schema 98 without changing existing chats", async () => {
    const { databasePath, workspacePath, conversations } = await schema98Database();
    expect(conversations.length).toBeGreaterThan(0);
    const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    try {
      expect(store.shellSnapshot().initiatives).toEqual([]);
      expect(store.shellSnapshot().conversations.every(({ initiativeId }) => initiativeId === null)).toBe(true);
    } finally {
      store.close();
    }
    const migrated = new Database(databasePath);
    try {
      expect((migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(conversationRows(migrated)).toEqual(conversations);
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM conversations WHERE initiative_id IS NOT NULL").get())
        .toEqual({ count: 0 });
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'conversations_initiative_idx'").get())
        .toEqual({ name: "conversations_initiative_idx" });
      const at = "2026-10-19T00:00:00.000Z";
      const initiativeId = randomUUID();
      migrated.prepare(`
        INSERT INTO initiatives (id, name, color, created_at, updated_at) VALUES (?, 'Migrated', 'blue', ?, ?)
      `).run(initiativeId, at, at);
      expect(migrated.prepare("SELECT status, brief, brief_revision, preferences_json, revision FROM initiatives").get())
        .toEqual({ status: "active", brief: "", brief_revision: 0, preferences_json: "{}", revision: 0 });
      migrated.prepare("UPDATE conversations SET initiative_id = ? WHERE id = ?").run(initiativeId, conversations[0]!.id);
      expect(() => migrated.prepare("UPDATE conversations SET initiative_id = 'short' WHERE id = ?")
        .run(conversations[0]!.id)).toThrow(/CHECK/u);
    } finally {
      migrated.close();
    }
  });

  it("clears membership with ON DELETE SET NULL after upgrading 98 to 99, leaving no dangling keys", async () => {
    const { databasePath, conversations } = await schema98Database();
    expect(conversations.length).toBeGreaterThan(0);
    const database = new Database(databasePath);
    try {
      migrateRuntimeDatabase(database, 99);
      database.pragma("foreign_keys = ON");
      const at = "2026-10-19T00:00:00.000Z";
      const initiativeId = randomUUID();
      database.prepare(`
        INSERT INTO initiatives (id, name, color, created_at, updated_at) VALUES (?, 'Upgraded', 'green', ?, ?)
      `).run(initiativeId, at, at);
      const assign = database.prepare("UPDATE conversations SET initiative_id = ? WHERE id = ?");
      for (const { id } of conversations) assign.run(initiativeId, id);
      expect(database.prepare("SELECT COUNT(*) AS count FROM conversations WHERE initiative_id = ?").get(initiativeId))
        .toEqual({ count: conversations.length });

      // A raw delete relies on the column's foreign key action, not the repository.
      database.prepare("DELETE FROM initiatives WHERE id = ?").run(initiativeId);
      expect(database.prepare("SELECT COUNT(*) AS count FROM conversations WHERE initiative_id IS NOT NULL").get())
        .toEqual({ count: 0 });
      expect(conversationRows(database)).toEqual(conversations);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("tolerates a schema 98 database that already has the membership column", async () => {
    const { databasePath, workspacePath, conversations } = await schema98Database((database) => {
      database.exec("ALTER TABLE conversations ADD COLUMN initiative_id TEXT");
    });
    const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    store.close();
    const migrated = new Database(databasePath, { readonly: true });
    try {
      expect(conversationRows(migrated)).toEqual(conversations);
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'initiatives'").get())
        .toEqual({ name: "initiatives" });
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'conversations_initiative_idx'").get())
        .toEqual({ name: "conversations_initiative_idx" });
    } finally {
      migrated.close();
    }
  });
});
