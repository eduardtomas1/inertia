import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { PromptPresetRepository } from "../../src/server/persistence/prompt-preset-repository";
import { TodoRepository } from "../../src/server/persistence/todo-repository";
import {
  cachedStatement,
  MAX_CACHED_STATEMENTS_PER_DATABASE,
} from "../../src/server/persistence/statement-cache";
import {
  clearCodecParseCaches,
  parseCachedModelSelectionJson,
} from "../../src/server/persistence/codec-parse-cache";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

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
    const command = (): void => {
      const activity = store.addActivity({
        conversationId: conversation.id, runId: turn.runId, turnId: turn.id,
        kind: "command", title: "npm test", detail: null, status: "running",
      });
      store.updateActivity(activity.id, { status: "completed" });
      const run = store.createWorkspaceRun({
        kind: "agent", projectId: project.id, conversationId: conversation.id,
        label: "Test", detail: null, status: "running", port: null,
      });
      store.updateWorkspaceRun(run.id, { status: "succeeded" });
      store.workspaceRunsForConversation(conversation.id);
      store.conversationShell(conversation.id);
    };
    stream();
    command();
    store.usageForConversation(conversation.id);
    store.createConversation(project.id, "Warm project guard");

    const prepare = vi.spyOn(Database.prototype, "prepare");
    for (let index = 0; index < 5; index += 1) {
      stream();
      command();
    }
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

  it("evicts the least-recently-used statement rather than the oldest inserted", () => {
    const database = new Database(":memory:");
    try {
      const hot = "SELECT 'hot' AS v";
      const hotStmt = cachedStatement(database, hot);
      const cold = "SELECT 'cold' AS v";
      cachedStatement(database, cold);
      for (let index = 0; index < MAX_CACHED_STATEMENTS_PER_DATABASE - 2; index += 1) {
        cachedStatement(database, `SELECT ${index} AS filler`);
      }
      // Touch `hot` so `cold` becomes the LRU entry.
      expect(cachedStatement(database, hot)).toBe(hotStmt);
      cachedStatement(database, "SELECT 'overflow' AS v");
      const prepare = vi.spyOn(database, "prepare");
      expect(cachedStatement(database, hot)).toBe(hotStmt);
      expect(prepare).not.toHaveBeenCalled();
      cachedStatement(database, cold);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("memoizes model selection JSON parses while returning mutation-isolated copies", () => {
    clearCodecParseCaches();
    const selection = providerNativeModelSelection({
      providerId: "claude",
      modelId: "claude-sonnet-4-5",
      alias: "sonnet",
      reasoningEffort: "medium",
    });
    const withNested = {
      ...selection,
      providerOptions: { nested: { flag: true } },
    };
    const raw = JSON.stringify(withNested);
    const parseSpy = vi.spyOn(JSON, "parse");
    const first = parseCachedModelSelectionJson(raw);
    const second = parseCachedModelSelectionJson(raw);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(withNested);
    expect(second).toEqual(withNested);
    expect(first).not.toBe(second);
    (first!.capabilities as unknown as string[]).push("mutated");
    (first!.providerOptions.nested as Record<string, unknown>).flag = false;
    const third = parseCachedModelSelectionJson(raw)!;
    expect(third.capabilities).toEqual(withNested.capabilities);
    expect((third.providerOptions.nested as Record<string, unknown>).flag).toBe(true);
  });

  it("invalidates prompt preset and todo list caches on same-connection/external writes and isolates caller mutations", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-preset-cache-"));
    directories.push(directory);
    const databasePath = join(directory, "inertia.sqlite");
    const bootstrap = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    bootstrap.close();

    const sameConn = new Database(databasePath);
    try {
      const presets = new PromptPresetRepository(sameConn);
      const todos = new TodoRepository(sameConn);
      const a = presets.create({
        name: "First",
        body: "Body A",
        route: { harnessId: "claude", backendProfileId: "native", modelId: "claude-sonnet-4-5", reasoningEffort: "medium" },
      });
      const b = presets.create({ name: "Second", body: "Body B", route: null });
      const firstList = presets.list();
      expect(firstList.map((p) => p.id)).toEqual([a.id, b.id]);

      // Caller mutations to both cold and warm returned arrays/objects must not corrupt cached entries.
      firstList.reverse();
      firstList[1]!.name = "Mutated";
      if (firstList[1]!.route) firstList[1]!.route.modelId = "mutated-model";
      const secondList = presets.list();
      expect(secondList.map((p) => p.id)).toEqual([a.id, b.id]);
      expect(secondList[0]!.name).toBe("First");
      expect(secondList[0]!.route?.modelId).toBe("claude-sonnet-4-5");
      secondList.reverse();
      secondList[1]!.name = "Mutated Warm";
      if (secondList[1]!.route) secondList[1]!.route.modelId = "mutated-warm-model";
      const thirdList = presets.list();
      expect(thirdList.map((p) => p.id)).toEqual([a.id, b.id]);
      expect(thirdList[0]!.name).toBe("First");
      expect(thirdList[0]!.route?.modelId).toBe("claude-sonnet-4-5");

      // True same-connection SQL reorder preserves row count, timestamps, and revision/position sums.
      sameConn.prepare("UPDATE prompt_presets SET position = CASE WHEN id = ? THEN 1 ELSE 0 END").run(a.id);
      expect(presets.list().map((p) => p.id)).toEqual([b.id, a.id]);

      // External connection write invalidates via PRAGMA data_version.
      const external = new Database(databasePath);
      try {
        external.prepare("UPDATE prompt_presets SET position = CASE WHEN id = ? THEN 0 ELSE 1 END").run(a.id);
      } finally {
        external.close();
      }
      expect(presets.list().map((p) => p.id)).toEqual([a.id, b.id]);

      // TodoRepository returns mutation-isolated copies on both cold and warm reads and invalidates on same-connection and external SQL updates.
      const todo1 = todos.create({ id: "11111111-1111-4111-8111-111111111111", title: "Alpha" });
      const todo2 = todos.create({ id: "22222222-2222-4222-8222-222222222222", title: "Beta" });
      const todoList1 = todos.list();
      expect(todoList1.map((t) => t.id)).toEqual([todo1.id, todo2.id]);
      todoList1.reverse();
      todoList1[0]!.title = "Tampered Cold";
      const todoList2 = todos.list();
      expect(todoList2.map((t) => t.title)).toEqual(["Alpha", "Beta"]);
      todoList2.reverse();
      todoList2[0]!.title = "Tampered Warm";
      expect(todos.list().map((t) => t.title)).toEqual(["Alpha", "Beta"]);
      sameConn.prepare("UPDATE todos SET title = 'Updated' WHERE id = ?").run(todo1.id);
      expect(todos.list().map((t) => t.title)).toEqual(["Updated", "Beta"]);
      const externalTodoDb = new Database(databasePath);
      try {
        externalTodoDb.prepare("UPDATE todos SET title = 'External' WHERE id = ?").run(todo2.id);
      } finally {
        externalTodoDb.close();
      }
      expect(todos.list().map((t) => t.title)).toEqual(["Updated", "External"]);
    } finally {
      sameConn.close();
    }
  });
});
