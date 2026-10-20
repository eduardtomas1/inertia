import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { countLimitTriggersAreValid } from "../../src/server/persistence/count-limit-triggers-schema";
import { executionContextKindsAreValid } from "../../src/server/persistence/execution-context-refs-schema";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const directories: string[] = [];
const AT = "2026-10-19T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type ReferenceRow = {
  turn_id: string;
  ordinal: number;
  digest: string;
  kind: string;
  label: string;
  byte_size: number;
  truncated: number;
};

/**
 * Migrates the published v0.0.6 fixture to schema 99 (initiatives, before
 * notes) and adds the rows migration 100 must carry: an initiative with a
 * brief and a member chat, and an execution-context reference.
 */
async function schema99Database() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-initiative-notes-migration-"));
  directories.push(directory);
  const databasePath = join(directory, "published.sqlite");
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  await copyFile(fixture, databasePath);
  const database = new Database(databasePath);
  try {
    migrateRuntimeDatabase(database, 99);
    const turn = database.prepare("SELECT id, conversation_id FROM agent_turns ORDER BY id LIMIT 1")
      .get() as { id: string; conversation_id: string } | undefined;
    if (!turn) throw new Error("The published fixture should carry backfilled turns.");
    const initiativeId = randomUUID();
    database.prepare(`
      INSERT INTO initiatives (id, name, color, brief, brief_revision, revision, created_at, updated_at)
      VALUES (?, 'Published', 'teal', 'Ship it.', 2, 3, ?, ?)
    `).run(initiativeId, AT, AT);
    database.prepare("UPDATE conversations SET initiative_id = ? WHERE id = ?").run(initiativeId, turn.conversation_id);
    const content = "Selected terminal output";
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    database.prepare(`
      INSERT INTO turn_execution_context_blobs (digest, byte_size, content, created_at) VALUES (?, ?, ?, ?)
    `).run(digest, Buffer.byteLength(content), content, AT);
    database.prepare(`
      INSERT INTO turn_execution_context_refs (turn_id, ordinal, digest, kind, label, byte_size, truncated)
      VALUES (?, 0, ?, 'terminal', 'Shell · lines 1-2', ?, 0)
    `).run(turn.id, digest, Buffer.byteLength(content));
    const references = database.prepare("SELECT * FROM turn_execution_context_refs ORDER BY turn_id, ordinal")
      .all() as ReferenceRow[];
    const messages = database.prepare("SELECT * FROM messages ORDER BY id").all();
    return { databasePath, workspacePath, initiativeId, turn, references, messages, digest };
  } finally {
    database.close();
  }
}

describe("initiative notes migration", () => {
  it("upgrades schema 99 to the current schema without changing initiatives, messages or execution references", async () => {
    const { databasePath, workspacePath, initiativeId, turn, references, messages } = await schema99Database();
    const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    try {
      expect(store.initiatives.get(initiativeId)).toMatchObject({
        brief: "Ship it.", briefRevision: 2, briefUpdatedAt: null, notesRevision: 0, proposedNoteCount: 0, revision: 3,
      });
      expect(store.initiatives.notes.list(initiativeId)).toEqual([]);
      expect(store.initiatives.deliveries.latestDelivered(turn.conversation_id)).toBeNull();
      expect(store.conversation(turn.conversation_id).initiativeId).toBe(initiativeId);
    } finally {
      store.close();
    }
    const migrated = new Database(databasePath);
    try {
      migrated.pragma("foreign_keys = ON");
      expect((migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(migrated.prepare("SELECT * FROM turn_execution_context_refs ORDER BY turn_id, ordinal").all()).toEqual(references);
      expect(migrated.prepare("SELECT * FROM messages ORDER BY id").all())
        .toEqual(messages.map((message) => ({ ...(message as object), initiative_context_json: null })));
      for (const name of [
        "initiative_notes_state_idx",
        "initiative_context_deliveries_conversation_idx",
        "turn_execution_context_refs_digest_idx",
      ]) {
        expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name))
          .toEqual({ name });
      }
      expect(countLimitTriggersAreValid(migrated, CURRENT_DATABASE_SCHEMA_VERSION)).toBe(true);

      // The rebuilt reference table accepts the new kind and keeps its other rules.
      const content = "Initiative: Published\n\nShip it.";
      const digest = createHash("sha256").update(content, "utf8").digest("hex");
      migrated.prepare(`
        INSERT INTO turn_execution_context_blobs (digest, byte_size, content, created_at) VALUES (?, ?, ?, ?)
      `).run(digest, Buffer.byteLength(content), content, AT);
      const insertReference = migrated.prepare(`
        INSERT INTO turn_execution_context_refs (turn_id, ordinal, digest, kind, label, byte_size, truncated)
        VALUES (?, ?, ?, ?, 'Initiative brief · Published · revision 2', ?, 0)
      `);
      insertReference.run(turn.id, 1, digest, "initiative", Buffer.byteLength(content));
      expect(() => insertReference.run(turn.id, 2, digest, "memory", Buffer.byteLength(content))).toThrow(/CHECK/u);
      // Deleting the last reference still prunes its blob.
      migrated.prepare("DELETE FROM turn_execution_context_refs WHERE turn_id = ? AND ordinal = 1").run(turn.id);
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM turn_execution_context_blobs WHERE digest = ?").get(digest))
        .toEqual({ count: 0 });

      // Notes, deliveries and receipts follow their initiative, chat and turn.
      migrated.prepare(`
        INSERT INTO initiative_notes (id, initiative_id, title, body, provenance, state, created_at, updated_at)
        VALUES (?, ?, 'Decision', 'Keep the form short.', 'user', 'accepted', ?, ?)
      `).run(randomUUID(), initiativeId, AT, AT);
      migrated.prepare(`
        INSERT INTO initiative_context_deliveries (
          id, conversation_id, initiative_id, initiative_name, turn_id,
          brief_revision, notes_revision, notes_digest, delivered_at
        ) VALUES (?, ?, ?, 'Published', ?, 2, 1, ?, ?)
      `).run(randomUUID(), turn.conversation_id, initiativeId, turn.id, "c".repeat(64), AT);
      expect(() => migrated.prepare(`
        INSERT INTO messages (id, conversation_id, turn_id, role, content, attachments_json, created_at, initiative_context_json)
        VALUES (?, ?, ?, 'assistant', 'x', '[]', ?, '{}')
      `).run(randomUUID(), turn.conversation_id, turn.id, AT)).toThrow(/CHECK/u);
      migrated.prepare("DELETE FROM initiatives WHERE id = ?").run(initiativeId);
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM initiative_notes").get()).toEqual({ count: 0 });
      // A delivery outlives its initiative by name, so its session is told it no longer applies.
      expect(migrated.prepare("SELECT initiative_id, initiative_name FROM initiative_context_deliveries").all())
        .toEqual([{ initiative_id: null, initiative_name: "Published" }]);
      expect(migrated.prepare("SELECT initiative_id FROM conversations WHERE id = ?").get(turn.conversation_id))
        .toEqual({ initiative_id: null });
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("tolerates a schema 99 database that already has the new columns", async () => {
    const { databasePath, workspacePath } = await schema99Database();
    const prepared = new Database(databasePath);
    try {
      prepared.exec(`
        ALTER TABLE initiatives ADD COLUMN notes_revision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE initiatives ADD COLUMN brief_updated_at TEXT;
        ALTER TABLE messages ADD COLUMN initiative_context_json TEXT;
      `);
    } finally {
      prepared.close();
    }
    const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    store.close();
    const migrated = new Database(databasePath, { readonly: true });
    try {
      expect((migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'initiative_notes'").get())
        .toEqual({ name: "initiative_notes" });
    } finally {
      migrated.close();
    }
  });

  it("treats a schema 100 database without the notes trigger as inconsistent", async () => {
    const { databasePath, workspacePath } = await schema99Database();
    const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    store.close();
    const database = new Database(databasePath);
    try {
      expect(countLimitTriggersAreValid(database, 100)).toBe(true);
      database.exec("DROP TRIGGER initiative_notes_count_limit");
      expect(countLimitTriggersAreValid(database, 100)).toBe(false);
      expect(countLimitTriggersAreValid(database, 99)).toBe(true);
    } finally {
      database.close();
    }
  });

  it("leaves an upgraded database with exactly the schema of a fresh one", async () => {
    const { databasePath, workspacePath } = await schema99Database();
    new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false }).close();
    const directory = await mkdtemp(join(tmpdir(), "inertia-initiative-notes-fresh-"));
    directories.push(directory);
    const freshPath = join(directory, "fresh.sqlite");
    new RuntimeStore(freshPath, directory, { recoverInterruptedRuns: false }).close();

    const schema = (path: string) => {
      const database = new Database(path, { readonly: true });
      try {
        return {
          objects: (database.prepare(`
            SELECT type, name, tbl_name, sql FROM sqlite_master
            WHERE name NOT LIKE 'sqlite_%'
            ORDER BY type, name
          `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>)
            .map((entry) => ({ ...entry, sql: entry.sql?.replace(/\s+/gu, " ").trim() ?? null })),
          foreignKeyProblems: database.prepare("PRAGMA foreign_key_check").all(),
        };
      } finally {
        database.close();
      }
    };
    const upgraded = schema(databasePath);
    const fresh = schema(freshPath);
    expect(upgraded.objects).toEqual(fresh.objects);
    expect(upgraded.foreignKeyProblems).toEqual([]);
    expect(fresh.foreignKeyProblems).toEqual([]);
  });

  it("requires the initiative execution context kind from schema 100", async () => {
    const { databasePath, workspacePath } = await schema99Database();
    const old = new Database(databasePath, { readonly: true });
    try {
      // Schema 99 still has the older reference table, which is valid for it.
      expect(executionContextKindsAreValid(old, 99)).toBe(true);
      // A database claiming schema 100 with that table refuses initiative context.
      expect(executionContextKindsAreValid(old, 100)).toBe(false);
    } finally {
      old.close();
    }
    new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false }).close();
    const migrated = new Database(databasePath, { readonly: true });
    try {
      expect(executionContextKindsAreValid(migrated, 100)).toBe(true);
    } finally {
      migrated.close();
    }
  });
});
