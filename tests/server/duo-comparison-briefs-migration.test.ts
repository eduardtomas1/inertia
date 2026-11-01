import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  DUO_COMPARISON_BRIEFS_SCHEMA_VERSION,
  duoComparisonBriefsMigration,
} from "../../src/server/persistence/migrations/duo-comparison-briefs";
import { migrateRuntimeDatabase, runtimeMigrationCatalog } from "../../src/server/persistence/migrations/runtime-catalog";
import type { DuoComparisonBrief } from "../../src/shared/duo-comparison-brief";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-duo-briefs-"));
  directories.push(directory);
  return directory;
}

function brief(overrides: Partial<DuoComparisonBrief> = {}): DuoComparisonBrief {
  return {
    launchId: "launch-1",
    sides: [
      { conversationId: "side-a", providerId: "codex", title: "Simplify sign-up", status: "completed", filesChanged: 2 },
      { conversationId: "side-b", providerId: "claude", title: "Simplify sign-up", status: "failed", filesChanged: null },
    ],
    ...overrides,
  };
}

describe("Duo comparison brief column", () => {
  it("is registered at its declared schema version", () => {
    expect(DUO_COMPARISON_BRIEFS_SCHEMA_VERSION).toBe(106);
    expect(DUO_COMPARISON_BRIEFS_SCHEMA_VERSION).toBeLessThanOrEqual(CURRENT_DATABASE_SCHEMA_VERSION);
    expect(runtimeMigrationCatalog().find(({ version }) => version === DUO_COMPARISON_BRIEFS_SCHEMA_VERSION))
      .toMatchObject({ name: duoComparisonBriefsMigration.name, up: duoComparisonBriefsMigration.up });
  });

  it("upgrades a schema 105 database without touching existing messages and only accepts bounded user JSON", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "published.sqlite");
    await copyFile(fixture, databasePath);
    const database = new Database(databasePath);
    try {
      migrateRuntimeDatabase(database, 105);
      const columns = () => (database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(({ name }) => name);
      expect(columns()).not.toContain("duo_comparison_json");
      const before = database.prepare("SELECT * FROM messages ORDER BY rowid").all();
      expect(before).not.toHaveLength(0);
      const history = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();

      migrateRuntimeDatabase(database);

      expect(columns()).toContain("duo_comparison_json");
      expect(database.prepare("SELECT * FROM messages ORDER BY rowid").all())
        .toEqual(before.map((row) => ({ ...(row as object), duo_comparison_json: null, delegated_completion_json: null })));
      expect(database.prepare("SELECT * FROM schema_migrations WHERE version <= 105 ORDER BY version").all()).toEqual(history);
      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);

      const assistant = database.prepare("SELECT id FROM messages WHERE role <> 'user' ORDER BY rowid LIMIT 1").pluck().get() as string | undefined;
      const user = database.prepare("SELECT id FROM messages WHERE role = 'user' ORDER BY rowid LIMIT 1").pluck().get() as string;
      const write = (id: string, value: string) => database.prepare("UPDATE messages SET duo_comparison_json = ? WHERE id = ?").run(value, id);
      expect(() => write(user, JSON.stringify(brief()))).not.toThrow();
      expect(() => write(user, "not json")).toThrow(/CHECK constraint failed/u);
      expect(() => write(user, "[]")).toThrow(/CHECK constraint failed/u);
      expect(() => write(user, JSON.stringify({ padding: "x".repeat(5_000) }))).toThrow(/CHECK constraint failed/u);
      if (assistant) expect(() => write(assistant, JSON.stringify(brief()))).toThrow(/CHECK constraint failed/u);
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");
      const schemaVersion = database.pragma("schema_version", { simple: true });
      migrateRuntimeDatabase(database);
      expect(database.pragma("schema_version", { simple: true })).toBe(schemaVersion);
    } finally {
      database.close();
    }
  });

  it("round-trips a validated brief on a fresh user message and leaves malformed rows unprojected", async () => {
    const directory = await temporaryDirectory();
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const databasePath = join(directory, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
    try {
      const project = store.createProject("Duo", workspace);
      const conversation = store.createConversation(project.id, "Judge");
      const flagged = store.createMessage(conversation.id, "# Independent Duo comparison", "user", [], null, undefined, { duoComparison: brief() });
      const plain = store.createMessage(conversation.id, "A follow-up question", "user");
      expect(flagged.duoComparison).toEqual(brief());
      expect(() => store.createMessage(conversation.id, "Answer", "assistant", [], null, undefined, { duoComparison: brief() }))
        .toThrow(/Invalid Duo comparison brief/u);
      expect(() => store.createMessage(conversation.id, "Forged", "user", [], null, undefined, {
        duoComparison: { ...brief(), extra: true } as DuoComparisonBrief,
      })).toThrow(/Invalid Duo comparison brief/u);
      const detail = store.conversationDetail(conversation.id)!;
      expect(detail.messages.find(({ id }) => id === flagged.id)?.duoComparison).toEqual(brief());
      expect(detail.messages.find(({ id }) => id === plain.id)).not.toHaveProperty("duoComparison");

      const raw = new Database(databasePath);
      raw.prepare("UPDATE messages SET duo_comparison_json = ? WHERE id = ?").run(JSON.stringify({ launchId: "launch-1" }), plain.id);
      raw.close();
      const reread = store.conversationDetail(conversation.id)!;
      expect(reread.messages.find(({ id }) => id === plain.id)).not.toHaveProperty("duoComparison");
      expect(reread.messages.find(({ id }) => id === flagged.id)?.duoComparison).toEqual(brief());
    } finally {
      store.close();
    }
  });
});
