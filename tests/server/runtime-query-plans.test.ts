import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { searchMessages } from "../../src/server/persistence/message-search";

interface RecordedQuery {
  sql: string;
  parameters: unknown[];
}

type HotPath = "app snapshot" | "history page" | "message search";

const recorded = new Map<HotPath, RecordedQuery[]>();
let directory = "";
let databasePath = "";

function recordReads(database: Database.Database, action: () => void): RecordedQuery[] {
  const queries: RecordedQuery[] = [];
  const prepare = database.prepare;
  const wrap = (statement: Database.Statement, sql: string): Database.Statement => {
    const proxy: Database.Statement = new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (property === "all" || property === "get" || property === "iterate") {
          return (...parameters: unknown[]) => {
            const normalized = sql.replace(/\s+/gu, " ").trim();
            if (/^(SELECT|WITH)\b/iu.test(normalized) && !queries.some((query) => query.sql === normalized)) {
              queries.push({ sql: normalized, parameters });
            }
            return (value as (...values: unknown[]) => unknown).apply(target, parameters);
          };
        }
        if (property === "pluck" || property === "raw" || property === "expand" || property === "safeIntegers") {
          return (...parameters: unknown[]) => {
            (value as (...values: unknown[]) => unknown).apply(target, parameters);
            return proxy;
          };
        }
        return (value as (...values: unknown[]) => unknown).bind(target);
      },
    });
    return proxy;
  };
  database.prepare = ((sql: string) => wrap(prepare.call(database, sql), sql)) as typeof database.prepare;
  try {
    action();
  } finally {
    database.prepare = prepare;
  }
  return queries;
}

function seed(store: RuntimeStore, workspace: string): { busyConversationId: string } {
  const at = (index: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, 0, 0) + index * 61_000).toISOString();
  let clock = 0;
  const projects = [0, 1, 2].map((index) => store.createProject(`Plans ${index}`, workspace));
  let busyConversationId = "";
  for (let index = 0; index < 36; index += 1) {
    const project = projects[index % projects.length]!;
    const conversation = store.createConversation(project.id, `Chat ${index}`, { activate: false });
    const turns = index === 0 ? 240 : 1 + (index % 6);
    if (index === 0) busyConversationId = conversation.id;
    for (let turnIndex = 0; turnIndex < turns; turnIndex += 1) {
      clock += 1;
      const requestedAt = at(clock);
      const runId = `run-${index}-${turnIndex}`;
      const { turn } = store.beginAgentTurn({
        id: `turn-${index}-${turnIndex}`, runId, conversationId: conversation.id,
        content: `Request ${turnIndex} about plans ${index % 5}`, providerId: "codex", harnessId: "codex-app-server",
        backendProfileId: "native:codex:app-server", model: "gpt-test", reasoningEffort: "high",
        interactionMode: "build", accessMode: "supervised", configurationRevision: 1,
        association: "authoritative", requestedAt,
      });
      for (let activity = 0; activity < 3; activity += 1) {
        store.addActivity({
          conversationId: conversation.id, runId, turnId: turn.id,
          kind: activity === 0 ? "command" : activity === 1 ? "tool" : "file",
          title: `Step ${activity}`, detail: "x".repeat(40), status: "completed", createdAt: requestedAt,
        });
      }
      store.createReasoning(conversation.id, runId, turn.id);
      const message = store.createMessage(conversation.id, `Answer ${turnIndex} for plans ${index % 7}`, "assistant", [], turn.id, requestedAt);
      store.updateAgentTurnLifecycle(turn.id, {
        status: "completed", startedAt: requestedAt, completedAt: requestedAt,
        updatedAt: requestedAt, terminalAssistantMessageId: message.id,
      });
    }
  }
  return { busyConversationId };
}

function plans(queries: readonly RecordedQuery[], statistics: "none" | "analyzed"): string[] {
  const database = new Database(databasePath);
  try {
    database.exec("ANALYZE sqlite_schema");
    if (statistics === "none") {
      const table = database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'").get();
      if (table) database.exec("DELETE FROM sqlite_stat1");
    } else {
      database.pragma("analysis_limit = 1000");
      database.exec("ANALYZE");
    }
    database.exec("ANALYZE sqlite_schema");
    const analyzed = database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'").get()
      ? database.prepare("SELECT COUNT(*) FROM sqlite_stat1").pluck().get() as number
      : 0;
    expect(analyzed > 0).toBe(statistics === "analyzed");
    return queries.map(({ sql, parameters }) =>
      (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{ detail: string }>)
        .map(({ detail }) => detail).join("\n"));
  } finally {
    database.close();
  }
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "inertia-query-plans-"));
  databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  try {
    const { busyConversationId } = seed(store, directory);
    const database = (store as unknown as { database: Database.Database }).database;
    recorded.set("app snapshot", recordReads(database, () => {
      store.shellSnapshot();
    }));
    recorded.set("history page", recordReads(database, () => {
      const latest = store.conversationHistory(busyConversationId)!;
      store.conversationHistory(busyConversationId, { before: latest.history!.older! });
    }));
  } finally {
    store.close();
  }
  const reader = new Database(databasePath, { readonly: true });
  try {
    recorded.set("message search", recordReads(reader, () => {
      searchMessages(reader, "plans 3");
    }));
  } finally {
    reader.close();
  }
}, 120_000);

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function shape(plan: string): string {
  return plan.replace(/USING (COVERING )?INDEX \S+/gu, (_match, covering: string | undefined) => `USING ${covering ?? ""}INDEX`);
}

const hotPaths: HotPath[] = ["app snapshot", "history page", "message search"];

describe("hot query plans on a seeded runtime database", () => {
  it.each(hotPaths)("snapshots every %s plan with and without planner statistics", (path) => {
    const queries = recorded.get(path)!;
    expect(queries.length).toBeGreaterThan(0);
    const without = plans(queries, "none");
    const analyzed = plans(queries, "analyzed");
    expect(queries.map(({ sql }, index) => ({
      query: sql.length > 160 ? `${sql.slice(0, 160)}…` : sql,
      withoutStatistics: without[index]!.split("\n"),
      withStatistics: analyzed[index] === without[index] ? "same" : analyzed[index]!.split("\n"),
    }))).toMatchSnapshot();
  });

  it.each(hotPaths)("never lets planner statistics turn a %s search into a scan or add a sort", (path) => {
    const queries = recorded.get(path)!;
    expect(plans(queries, "analyzed").map(shape)).toEqual(plans(queries, "none").map(shape));
  });

  it("reads history pages and search through conversation-ordered and covering indexes", () => {
    const history = plans(recorded.get("history page")!, "analyzed").join("\n");
    expect(history).toMatch(/SEARCH messages USING (COVERING )?INDEX messages_conversation_created_idx/u);
    expect(history).toMatch(/SEARCH activities USING INDEX activities_conversation_turn_created_idx/u);
    expect(history).toMatch(/SEARCH agent_reasonings USING (COVERING )?INDEX agent_reasonings_conversation_turn_created_idx/u);
    expect(history).not.toMatch(/\bSCAN (messages|activities|agent_reasonings|agent_turns)$/mu);
    const search = plans(recorded.get("message search")!, "analyzed").join("\n");
    expect(search).toMatch(/SCAN messages USING COVERING INDEX messages_created_id_idx/u);
    const snapshot = plans(recorded.get("app snapshot")!, "analyzed").join("\n");
    expect(snapshot).toMatch(/SEARCH latest USING COVERING INDEX agent_turns_conversation_requested_idx/u);
  });
});
