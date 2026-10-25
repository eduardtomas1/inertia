import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { optimizeRuntimeConnection } from "../../src/server/persistence/runtime-connection-pragmas";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const directories: string[] = [];
const turnIndexes = [
  ["activities", "activities_turn_idx"],
  ["messages", "messages_turn_idx"],
  ["agent_reasonings", "agent_reasonings_turn_idx"],
] as const;
const legacyIndexes = [
  "activities_conversation_id_idx",
  "messages_conversation_id_idx",
  "agent_reasonings_conversation_id_idx",
];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-turn-indexes-"));
  directories.push(directory);
  return directory;
}

function indexNames(database: Database.Database): string[] {
  return database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    .pluck().all() as string[];
}

function rows(database: Database.Database, table: string): unknown[] {
  return database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function plan(database: Database.Database, sql: string, ...parameters: unknown[]): string {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{ detail: string }>)
    .map(({ detail }) => detail).join("\n");
}

describe("turn-scoped row indexes", () => {
  it("upgrades schema 101 so turn deletion searches child rows by turn and the prefix indexes are gone", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "published.sqlite");
    await copyFile(fixture, databasePath);
    const database = new Database(databasePath);
    try {
      migrateRuntimeDatabase(database, 101);
      database.pragma("foreign_keys = ON");
      expect(indexNames(database)).toEqual(expect.arrayContaining(legacyIndexes));
      const before = Object.fromEntries(turnIndexes.map(([table]) => [table, rows(database, table)]));
      expect(before.activities).not.toHaveLength(0);
      const history = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();

      migrateRuntimeDatabase(database);

      const names = indexNames(database);
      for (const legacy of legacyIndexes) expect(names).not.toContain(legacy);
      const rootPages = new Map((database.prepare(
        "SELECT rootpage, name FROM sqlite_master WHERE type = 'index'",
      ).all() as Array<{ rootpage: number; name: string }>).map(({ rootpage, name }) => [rootpage, name]));
      const deletion = (database.prepare("EXPLAIN DELETE FROM agent_turns WHERE id = ?").all("turn") as Array<{
        opcode: string;
        p2: number;
      }>).filter(({ opcode }) => opcode === "OpenRead" || opcode === "OpenWrite")
        .map(({ p2 }) => rootPages.get(p2));
      for (const [table, index] of turnIndexes) {
        expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(index))
          .toMatch(new RegExp(`ON ${table}\\(turn_id\\)\\s+WHERE turn_id IS NOT NULL`, "u"));
        expect(plan(database, `UPDATE ${table} SET turn_id = NULL WHERE turn_id = ?`, "turn"))
          .toMatch(new RegExp(`SEARCH ${table} USING (COVERING )?INDEX ${index} \\(turn_id=\\?\\)`, "u"));
        expect(deletion).toContain(index);
        expect(rows(database, table)).toEqual(before[table]);
      }
      expect(plan(database, `
        SELECT id FROM activities
        WHERE conversation_id = ? AND turn_id = ? AND kind IN ('command', 'tool', 'file', 'error')
        ORDER BY created_at ASC, rowid ASC
      `, "conversation", "turn")).toContain("activities_conversation_turn_created_idx");
      expect(database.prepare("SELECT * FROM schema_migrations WHERE version <= 101 ORDER BY version").all())
        .toEqual(history);
      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get())
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");
      const schemaVersion = database.pragma("schema_version", { simple: true });
      migrateRuntimeDatabase(database);
      expect(database.pragma("schema_version", { simple: true })).toBe(schemaVersion);
    } finally {
      database.close();
    }
  });

  it("collects planner statistics for a writable runtime database without touching read-only connections", async () => {
    const directory = await temporaryDirectory();
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const databasePath = join(directory, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
    const project = store.createProject("Statistics", workspace);
    for (let index = 0; index < 12; index += 1) store.createConversation(project.id, `Chat ${index}`, { activate: false });
    store.close();
    const statistics = (path: string) => {
      const database = new Database(path, { readonly: true });
      try {
        return database.prepare("SELECT DISTINCT tbl FROM sqlite_stat1").pluck().all() as string[];
      } catch {
        return [];
      } finally {
        database.close();
      }
    };
    expect(statistics(databasePath)).toContain("conversations");

    const untouchedPath = join(directory, "untouched.sqlite");
    const seeded = new Database(untouchedPath);
    seeded.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT); CREATE INDEX items_label_idx ON items(label);");
    const insert = seeded.prepare("INSERT INTO items (label) VALUES (?)");
    for (let index = 0; index < 20; index += 1) insert.run(`item-${index % 4}`);
    seeded.close();
    const readonly = new Database(untouchedPath, { readonly: true });
    expect(() => optimizeRuntimeConnection(readonly)).not.toThrow();
    readonly.close();
    const queryOnly = new Database(untouchedPath);
    queryOnly.pragma("query_only = ON");
    expect(() => optimizeRuntimeConnection(queryOnly)).not.toThrow();
    queryOnly.close();
    expect(statistics(untouchedPath)).toEqual([]);
  });
});
