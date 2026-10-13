// @inertia-test-suite portable
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase, runtimeMigrationCatalog } from "../../src/server/persistence/migrations/runtime-catalog";

const settledAt = () => { const at = new Date().toISOString(); return { startedAt: at, completedAt: at }; };
let directory: string;
let databasePath: string;
let store: RuntimeStore;
let projectId: string;

function chatWithTurn(title = "Running task") {
  const conversation = store.createConversation(projectId, title, { model: "gpt-test" });
  const run = store.createWorkspaceRun({ kind: "agent", projectId, conversationId: conversation.id,
    label: "Task", detail: null, status: "running", port: null });
  const turn = store.beginAgentTurn({ conversationId: conversation.id, runId: run.id, content: "Refactor the parser.",
    providerId: conversation.providerId, modelSelection: conversation.modelSelection, model: "gpt-test",
    reasoningEffort: conversation.reasoningEffort, interactionMode: conversation.interactionMode,
    accessMode: conversation.accessMode, configurationRevision: 0, association: "authoritative" }).turn;
  return { conversationId: conversation.id, turnId: turn.id, runId: run.id };
}

function planInput(chat: { conversationId: string; turnId: string }, routeIdentity = "route-a") {
  return { conversationId: chat.conversationId, interruptedTurnId: chat.turnId, routeIdentity };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "inertia-restart-plans-"));
  databasePath = join(directory, "inertia.sqlite");
  store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  projectId = store.createProject("Project", directory).id;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("restart continuation plan migration", () => {
  it("creates the plan table as schema 97", () => {
    store.close();
    const database = new Database(databasePath, { readonly: true });
    try {
      expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(97);
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 97 });
      expect(runtimeMigrationCatalog().find(({ version }) => version === 97)?.name).toBe("PersistRestartContinuationPlans");
      expect((database.prepare("PRAGMA table_info(restart_continuation_plans)").all() as Array<{ name: string }>)
        .map(({ name }) => name)).toEqual([
        "id", "conversation_id", "interrupted_turn_id", "route_identity", "state", "attempts", "turn_id", "error",
        "created_at", "updated_at",
      ]);
    } finally {
      database.close();
      store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    }
  });

  it("upgrades a schema 96 database with chats in place", () => {
    const chat = chatWithTurn();
    store.close();
    const older = new Database(databasePath);
    older.exec("DROP TABLE restart_continuation_plans; DELETE FROM schema_migrations WHERE version >= 97;");
    older.close();
    const upgraded = new Database(databasePath);
    try {
      upgraded.pragma("foreign_keys = ON");
      migrateRuntimeDatabase(upgraded);
      expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 97 });
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM restart_continuation_plans").get()).toEqual({ count: 0 });
      expect(upgraded.prepare("SELECT id FROM agent_turns").all()).toEqual([{ id: chat.turnId }]);
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
    }
    store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    const [plan] = store.restartContinuations.createForConversations([planInput(chat)]);
    expect(plan).toMatchObject({ conversationId: chat.conversationId, interruptedTurnId: chat.turnId, state: "waiting" });
  });

  it("rejects unknown plan states", () => {
    const chat = chatWithTurn();
    const [plan] = store.restartContinuations.createForConversations([planInput(chat)]);
    store.close();
    const database = new Database(databasePath);
    try {
      expect(() => database.prepare("UPDATE restart_continuation_plans SET state = 'missed' WHERE id = ?").run(plan!.id))
        .toThrow(/CHECK constraint/u);
    } finally {
      database.close();
      store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    }
  });
});

describe("restart continuation plan repository", () => {
  it("reuses one repository per open database", () => {
    expect(store.restartContinuations).toBe(store.restartContinuations);
    const other = new RuntimeStore(join(directory, "other.sqlite"), directory, { recoverInterruptedRuns: false });
    try {
      expect(other.restartContinuations).not.toBe(store.restartContinuations);
    } finally { other.close(); }
  });

  it("creates one waiting plan per chat in one transaction and replaces an older plan", () => {
    const first = chatWithTurn("First");
    const second = chatWithTurn("Second");
    const created = store.restartContinuations.createForConversations([planInput(first), planInput(second, "route-b")]);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      conversationId: first.conversationId, interruptedTurnId: first.turnId, routeIdentity: "route-a",
      state: "waiting", attempts: 0, turnId: null, error: null,
    });
    expect(created[0]!.createdAt).toBe(created[0]!.updatedAt);
    expect(store.restartContinuations.listWaiting().map(({ conversationId }) => conversationId).sort())
      .toEqual([first.conversationId, second.conversationId].sort());
    store.restartContinuations.cancel(created[0]!, "The chat changed.");
    const [replacement] = store.restartContinuations.createForConversations([planInput(first, "route-c")]);
    expect(replacement!.id).not.toBe(created[0]!.id);
    expect(store.restartContinuations.forConversation(first.conversationId)).toMatchObject({
      id: replacement!.id, routeIdentity: "route-c", state: "waiting", attempts: 0, error: null,
    });
  });

  it("writes no plan when any chat in the batch is missing", () => {
    const first = chatWithTurn();
    expect(() => store.restartContinuations.createForConversations([
      planInput(first), { conversationId: "missing-conversation", interruptedTurnId: "missing-turn", routeIdentity: "route" },
    ])).toThrow();
    expect(store.restartContinuations.forConversation(first.conversationId)).toBeNull();
  });

  it("claims a waiting plan exactly once and completes it with the new turn", () => {
    const chat = chatWithTurn();
    const [plan] = store.restartContinuations.createForConversations([planInput(chat)]);
    expect(store.restartContinuations.claim(plan!)).toBe(true);
    expect(store.restartContinuations.claim(plan!)).toBe(false);
    expect(store.restartContinuations.listWaiting()).toEqual([]);
    store.restartContinuations.complete(plan!, "next-turn");
    expect(store.restartContinuations.forConversation(chat.conversationId)).toMatchObject({
      state: "completed", attempts: 1, turnId: "next-turn", error: null,
    });
    expect(() => store.restartContinuations.complete(plan!, "other-turn")).toThrow("no longer owns");
  });

  it("returns an unconfirmed dispatch to waiting on reconcile and never a completed one", () => {
    const first = chatWithTurn("First");
    const second = chatWithTurn("Second");
    const [unconfirmed, confirmed] = store.restartContinuations.createForConversations([planInput(first), planInput(second)]);
    store.restartContinuations.claim(unconfirmed!);
    store.restartContinuations.claim(confirmed!);
    store.restartContinuations.complete(confirmed!, "next-turn");
    store.close();
    store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    store.restartContinuations.reconcile();
    expect(store.restartContinuations.forConversation(first.conversationId)).toMatchObject({ state: "waiting", attempts: 1 });
    expect(store.restartContinuations.forConversation(second.conversationId)).toMatchObject({ state: "completed", turnId: "next-turn" });
  });

  it("releases a failed dispatch for retry and blocks it with a bounded error", () => {
    const chat = chatWithTurn();
    const [plan] = store.restartContinuations.createForConversations([planInput(chat)]);
    store.restartContinuations.claim(plan!);
    store.restartContinuations.release(plan!, "The provider is not ready.");
    expect(store.restartContinuations.forConversation(chat.conversationId)).toMatchObject({
      state: "waiting", attempts: 1, error: "The provider is not ready.",
    });
    store.restartContinuations.claim(plan!);
    store.restartContinuations.block(plan!, "x".repeat(2_000));
    const blocked = store.restartContinuations.forConversation(chat.conversationId)!;
    expect(blocked).toMatchObject({ state: "blocked", attempts: 2 });
    expect(blocked.error).toHaveLength(1_000);
    expect(store.restartContinuations.claim(plan!)).toBe(false);
  });

  it("cancels an open plan with its reason but never a completed one", () => {
    const first = chatWithTurn("First");
    const second = chatWithTurn("Second");
    const [open, done] = store.restartContinuations.createForConversations([planInput(first), planInput(second)]);
    expect(store.restartContinuations.cancel(open!, "The chat was archived.")).toBe(true);
    expect(store.restartContinuations.forConversation(first.conversationId)).toMatchObject({
      state: "cancelled", error: "The chat was archived.",
    });
    store.restartContinuations.claim(done!);
    store.restartContinuations.complete(done!, "next-turn");
    expect(store.restartContinuations.cancel(done!, "Too late.")).toBe(false);
    expect(store.restartContinuations.forConversation(second.conversationId)).toMatchObject({ state: "completed", error: null });
  });

  it("completes a claimed plan in the same transaction as the continuation turn", () => {
    const chat = chatWithTurn();
    store.updateAgentTurnLifecycle(chat.turnId, { status: "interrupted", terminalReason: "app-update", ...settledAt() });
    const [plan] = store.restartContinuations.createForConversations([planInput(chat)]);
    const conversation = store.conversation(chat.conversationId);
    const run = store.createWorkspaceRun({ kind: "agent", projectId, conversationId: chat.conversationId,
      label: "Task", detail: null, status: "running", port: null });
    const continuation = () => store.beginAgentTurn({ conversationId: chat.conversationId, runId: run.id,
      content: "Continue from where you stopped.", providerId: conversation.providerId, modelSelection: conversation.modelSelection,
      model: "gpt-test", reasoningEffort: conversation.reasoningEffort, interactionMode: conversation.interactionMode,
      accessMode: conversation.accessMode, configurationRevision: 0, association: "authoritative",
      restartContinuationPlanId: plan!.id }).turn;
    expect(continuation).toThrow("no longer owns");
    expect(store.latestAgentTurnForConversation(chat.conversationId)?.id).toBe(chat.turnId);
    expect(store.conversationDetail(chat.conversationId)!.messages.map(({ content }) => content)).toEqual(["Refactor the parser."]);
    store.restartContinuations.claim(plan!);
    const turn = continuation();
    expect(store.restartContinuations.forConversation(chat.conversationId)).toMatchObject({ state: "completed", turnId: turn.id });
  });

  it("deletes a chat's plan with the chat", () => {
    const chat = chatWithTurn();
    store.restartContinuations.createForConversations([planInput(chat)]);
    store.deleteConversation(chat.conversationId);
    expect(store.restartContinuations.forConversation(chat.conversationId)).toBeNull();
  });
});
