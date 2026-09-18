import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  cachedStatement,
  MAX_CACHED_STATEMENTS_PER_DATABASE,
} from "../../src/server/persistence/statement-cache";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-statement-cache-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("per-connection prepared statement cache", () => {
  it("reuses one statement per connection and SQL text within a fixed bound", () => {
    const first = new Database(":memory:");
    const second = new Database(":memory:");
    try {
      const sql = "SELECT 1 AS value";
      const statement = cachedStatement(first, sql);
      expect(cachedStatement(first, sql)).toBe(statement);
      expect(cachedStatement(second, sql)).not.toBe(statement);
      for (let index = 0; index < MAX_CACHED_STATEMENTS_PER_DATABASE; index += 1) {
        cachedStatement(first, `SELECT ${index} AS other`);
      }
      const prepare = vi.spyOn(first, "prepare");
      const newest = `SELECT ${MAX_CACHED_STATEMENTS_PER_DATABASE - 1} AS other`;
      cachedStatement(first, newest);
      expect(prepare).not.toHaveBeenCalled();
      const replacement = cachedStatement(first, sql);
      expect(replacement).not.toBe(statement);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(replacement.get()).toEqual({ value: 1 });
      cachedStatement(first, "SELECT 0 AS other");
      expect(prepare).toHaveBeenCalledTimes(2);
    } finally {
      first.close();
      second.close();
    }
  });

  it("follows schema changes and table rebuilds on the same connection", () => {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const insert = "INSERT INTO records (id, value) VALUES (?, ?)";
      const select = "SELECT * FROM records WHERE id = ?";
      cachedStatement(database, insert).run("a", "first");
      expect(cachedStatement(database, select).get("a"))
        .toEqual({ id: "a", value: "first" });

      database.exec("ALTER TABLE records ADD COLUMN extra TEXT NOT NULL DEFAULT 'added'");
      expect(cachedStatement(database, select).get("a"))
        .toEqual({ id: "a", value: "first", extra: "added" });

      database.exec(`
        CREATE TABLE records_next (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO records_next (id, value) SELECT id, value FROM records;
        DROP TABLE records;
        ALTER TABLE records_next RENAME TO records;
      `);
      cachedStatement(database, insert).run("b", "second");
      expect(cachedStatement(database, select).get("a"))
        .toEqual({ id: "a", value: "first", revision: 1 });
      expect(cachedStatement(database, select).get("b"))
        .toEqual({ id: "b", value: "second", revision: 1 });

      database.exec("DROP TABLE records");
      expect(() => cachedStatement(database, select).get("a"))
        .toThrow(/no such table: records/u);
    } finally {
      database.close();
    }
  });

  it("never serves a closed connection's statement to a reopened database", () => {
    const databasePath = join(temporaryDirectory(), "cache.sqlite");
    const original = new Database(databasePath);
    original.exec("CREATE TABLE records (id TEXT PRIMARY KEY)");
    const sql = "SELECT id FROM records WHERE id = ?";
    const stale = cachedStatement(original, sql);
    original.close();
    expect(() => stale.get("a")).toThrow(/database connection is not open/u);
    expect(() => cachedStatement(original, sql).get("a"))
      .toThrow(/database connection is not open/u);

    const reopened = new Database(databasePath);
    try {
      reopened.prepare("INSERT INTO records (id) VALUES ('a')").run();
      const fresh = cachedStatement(reopened, sql);
      expect(fresh).not.toBe(stale);
      expect(fresh.get("a")).toEqual({ id: "a" });
    } finally {
      reopened.close();
    }
  });

  it("keeps streamed appends and identity guards off the SQL compiler after first use", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    let store = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Cache", directory);
    const conversation = store.createConversation(project.id, "Cache");
    const user = store.createMessage(conversation.id, "Start", "user");
    const turn = store.createAgentTurn({
      id: "turn-statement-cache",
      conversationId: conversation.id,
      runId: "run-statement-cache",
      userMessageId: user.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "legacy:codex:codex-app-server",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    store.updateAgentTurnLifecycle(turn.id, { status: "running" });
    const assistant = store.createMessage(conversation.id, "", "assistant", [], turn.id);
    const reasoning = store.createReasoning(conversation.id, turn.runId, turn.id);
    const stream = (): void => {
      store.appendMessageContent(assistant.id, "a");
      store.appendReasoningContent(reasoning.id, "r");
      store.assertAgentTurnIdentity(conversation.id, turn.runId, turn.id);
    };
    stream();
    store.usageForConversation(conversation.id);
    store.createConversation(project.id, "Warm project guard");

    const prepare = vi.spyOn(Database.prototype, "prepare");
    for (let index = 0; index < 5; index += 1) stream();
    expect(prepare).not.toHaveBeenCalled();
    store.usageForConversation(conversation.id);
    store.createConversation(project.id, "Cached project guard");
    for (const sql of [
      "SELECT * FROM projects WHERE id = ?",
      "SELECT * FROM conversations WHERE id = ?",
      "SELECT * FROM agent_turns WHERE id = ?",
    ]) {
      expect(prepare.mock.calls.some(([prepared]) => prepared === sql)).toBe(false);
    }
    prepare.mockRestore();

    expect(store.message(assistant.id).content).toBe("a".repeat(6));
    expect(() => store.appendMessageContent("missing-message", "x"))
      .toThrow("Message not found.");
    expect(() => store.appendReasoningContent("missing-reasoning", "x"))
      .toThrow("Reasoning summary not found.");
    expect(() => store.assertAgentTurnIdentity(conversation.id, "other-run", turn.id))
      .toThrow("The event conversation, run, and turn identities do not match.");
    store.close();

    store = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    try {
      store.appendMessageContent(assistant.id, "b");
      store.appendReasoningContent(reasoning.id, "s");
      expect(store.message(assistant.id).content).toBe("aaaaaab");
      expect(store.assertAgentTurnIdentity(conversation.id, turn.runId, turn.id).id)
        .toBe(turn.id);
    } finally {
      store.close();
    }
  });
});
