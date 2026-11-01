import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { OrchestrationEventStore } from "../../src/server/orchestration-v2/event-store";
import { ORCHESTRATION_V2_PROJECTION_VERSION, projectOrchestrationEvent } from "../../src/server/orchestration-v2/projector";
import { OrchestratedTurnRepository } from "../../src/server/orchestration-v2/turn-repository";
import {
  OrchestrationCommandRejected,
  OrchestrationConflict,
  OrchestrationProjectionVerificationError,
  type CommandCommit,
  type ProjectEvent,
} from "../../src/server/orchestration-v2/types";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { orchestrationV2Migration } from "../../src/server/persistence/migrations/orchestration-v2";
import { orchestrationV2ReceiptStatusMigration } from "../../src/server/persistence/migrations/orchestration-v2-receipt-status";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { orchestrationAttemptSchema, orchestrationRunSchema, orchestrationThreadSchema } from "../../src/shared/orchestration-v2";
import { RuntimeStartupBlockerError } from "../../src/shared/runtime-startup-diagnostics";
import { runtimeStartupErrorEvent } from "../../src/server/runtime-worker-startup-failure";
import { createDelegationFixture } from "../support/delegation-fixture";
import { removeDelegatedTasksFromFixture } from "../support/legacy-project-settings-schema";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

const databases: Database.Database[] = [];
const project: ProjectEvent = (event) => [{ kind: "test", id: event.threadId, value: event.payload }];
const migrateReceiptStatus = orchestrationV2ReceiptStatusMigration.up as (database: Database.Database) => void;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.open) db.close();
  await cleanupTurnControllerTestDirectories();
});

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(orchestrationV2Migration.up as string);
  migrateReceiptStatus(db);
  const clock = () => "2026-11-01T10:00:00.000Z";
  return { db, clock, store: new OrchestrationEventStore(db, project, "runtime-1", clock) };
}

function command(overrides: Partial<CommandCommit> = {}): CommandCommit {
  return { actorId: "human", commandId: "request-1", projectId: "project-1", threadId: "thread-1",
    command: { type: "message.send", text: "hello" }, expectedRevision: 0,
    events: [{ type: "test.accepted", payload: { value: 1 } }], result: { accepted: true }, ...overrides };
}

function rejection(overrides: Partial<CommandCommit> & { error?: string; commandType?: string } = {}) {
  const base = command(overrides);
  return { actorId: base.actorId, commandId: base.commandId, projectId: base.projectId, threadId: base.threadId,
    command: base.command, commandType: overrides.commandType ?? "message.send",
    error: overrides.error ?? "That provider is not configured." };
}

function metadata(db: Database.Database) {
  return db.prepare("SELECT schema_version, last_sequence, updated_at FROM orchestration_v2_projection_metadata").get() as
    { schema_version: number; last_sequence: number; updated_at: string };
}

function storeDatabase(store: RuntimeStore): Database.Database {
  return (store as unknown as { database: Database.Database }).database;
}

function entities(db: Database.Database) {
  return db.prepare(`SELECT kind, id, project_id, thread_id, revision, payload_json
    FROM orchestration_v2_entities ORDER BY kind, id`).all();
}

function receipts(db: Database.Database) {
  return db.prepare(`SELECT actor_id, command_id, thread_id, project_id, fingerprint, first_sequence, last_sequence,
    result_json, created_at FROM orchestration_v2_receipts ORDER BY actor_id, command_id`).all();
}

async function completedRuntime(): Promise<TurnControllerTestRuntime> {
  const runtime = await createTurnControllerTestRuntime();
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "First request" });
  runtime.controller.start(queued.turn.id);
  runtime.provider.resolve({ text: "First answer" });
  await flushTurnControllerTestPromises();
  return runtime;
}

describe("Orchestrator V2 receipt status", () => {
  it("replays a rejected human command as rejected and keeps payload conflicts", () => {
    const { db, store } = fixture();
    const rejected = store.reject(rejection());
    expect(rejected).toMatchObject({ actorId: "human", commandId: "request-1", status: "rejected",
      error: "That provider is not configured.", commandType: "message.send", result: null,
      firstSequence: null, lastSequence: null });
    const replay = () => store.commit(command());
    expect(replay).toThrow(OrchestrationCommandRejected);
    expect(replay).toThrow("That provider is not configured.");
    try {
      replay();
    } catch (error) {
      expect(error).toMatchObject({ commandId: "request-1", detail: "That provider is not configured." });
    }
    expect(() => store.receipt(command(), command().command)).toThrow(OrchestrationCommandRejected);
    expect(() => store.commit(command({ command: { type: "message.send", text: "different" } })))
      .toThrow("command-conflict");
    expect(() => store.commit(command({ threadId: "thread-2" }))).toThrow(OrchestrationConflict);
    expect(store.reject(rejection({ error: "A later refusal." }))).toEqual(rejected);
    expect(store.revision("thread-1")).toBe(0);
    expect(store.projection("test", "thread-1")).toBeNull();
    expect(metadata(db).last_sequence).toBe(0);
  });

  it("keeps human and runtime receipts independent for the same command id", () => {
    const { store } = fixture();
    store.reject(rejection());
    const runtime = store.commit(command({ actorId: "runtime" }));
    expect(runtime).toMatchObject({ replayed: false, receipt: { actorId: "runtime", status: "accepted", error: null,
      commandType: "message.send" } });
    expect(() => store.commit(command({ expectedRevision: 1 }))).toThrow(OrchestrationCommandRejected);
    expect(store.commit(command({ actorId: "runtime", expectedRevision: 7 }))).toEqual({ replayed: true,
      receipt: runtime.receipt, events: [] });
    expect(store.reject(rejection({ actorId: "runtime" }))).toEqual(runtime.receipt);
    expect(store.receipt(command({ actorId: "runtime" }), command().command)).toEqual(runtime.receipt);

    const accepted = store.commit(command({ commandId: "request-2", expectedRevision: 1 }));
    expect(accepted.receipt).toMatchObject({ actorId: "human", status: "accepted" });
    expect(() => store.commit(command({ commandId: "request-2", expectedRevision: 2,
      command: { type: "message.send", text: "other" } }))).toThrow("command-conflict");
    expect(() => store.receipt(command({ commandId: "request-2" }), { type: "message.send", text: "other" }))
      .toThrow("command-conflict");
  });

  it("records no-op commands as accepted without moving the projection sequence", () => {
    const { db, store } = fixture();
    store.commit(command());
    const before = metadata(db);
    const noOp = store.commit(command({ commandId: "request-2", expectedRevision: 1, events: [], result: null }));
    expect(noOp).toMatchObject({ replayed: false, events: [], receipt: { status: "accepted", firstSequence: null,
      lastSequence: null, commandType: "message.send" } });
    expect(metadata(db)).toEqual(before);
    expect(store.commit(command({ commandId: "request-2", expectedRevision: 1, events: [], result: null })).replayed)
      .toBe(true);
  });

  it("derives command types and bounds rejection errors", () => {
    const { db, store } = fixture();
    expect(store.commit(command({ commandType: "conversation.fork" })).receipt.commandType).toBe("conversation.fork");
    expect(store.commit(command({ commandId: "request-2", expectedRevision: 1, command: { text: "untyped" } }))
      .receipt.commandType).toBe("test.accepted");
    expect(store.commit(command({ commandId: "request-3", expectedRevision: 2, command: ["list"], events: [] }))
      .receipt.commandType).toBe("unknown");
    expect(() => store.commit(command({ commandId: "request-4", expectedRevision: 2, commandType: "" })))
      .toThrow("Invalid orchestration identity");
    const long = store.reject(rejection({ commandId: "request-5", error: `  ${"x".repeat(1_500)}  ` }));
    expect(long.error).toHaveLength(1_000);
    expect(store.reject(rejection({ commandId: "request-6", error: "   " })).error).toBe("The command was rejected.");
    expect(() => store.reject(rejection({ commandId: "request-7", commandType: "y".repeat(241) })))
      .toThrow("Invalid orchestration identity");
    expect(db.prepare("SELECT command_id, status FROM orchestration_v2_receipts ORDER BY command_id").all()).toEqual([
      { command_id: "request-1", status: "accepted" }, { command_id: "request-2", status: "accepted" },
      { command_id: "request-3", status: "accepted" }, { command_id: "request-5", status: "rejected" },
      { command_id: "request-6", status: "rejected" },
    ]);
  });
});

describe("Orchestrator V2 projection metadata", () => {
  it("advances the projection sequence with every commit and verifies afterwards", () => {
    const { db, store } = fixture();
    expect(store.verify()).toMatchObject({ valid: true, schemaVersion: ORCHESTRATION_V2_PROJECTION_VERSION,
      expectedSequence: 0, projectionSequence: 0 });
    store.commit(command({ events: [{ type: "a", payload: 1 }, { type: "b", payload: 2 }] }));
    expect(metadata(db)).toMatchObject({ last_sequence: 2, updated_at: "2026-11-01T10:00:00.000Z" });
    store.commit(command({ commandId: "request-2", expectedRevision: 2 }));
    expect(metadata(db).last_sequence).toBe(3);
    expect(store.verify()).toEqual({ valid: true, schemaVersion: 1, expectedSchemaVersion: 1, expectedSequence: 3,
      projectionSequence: 3, missingThreadIds: [], unexpectedThreadIds: [], unreadable: [] });
    db.prepare("UPDATE orchestration_v2_projection_metadata SET last_sequence = 2").run();
    expect(store.verify()).toMatchObject({ valid: false, expectedSequence: 3, projectionSequence: 2 });
    store.rebuildProjections();
    expect(store.verify().valid).toBe(true);
    db.prepare("DELETE FROM orchestration_v2_projection_metadata").run();
    expect(store.verify()).toMatchObject({ valid: false, schemaVersion: 0, projectionSequence: 0 });
    store.rebuildProjections();
    expect(store.verify().valid).toBe(true);
  });

  it("fails verification after a projector version bump and passes after a rebuild", () => {
    const { db, clock, store } = fixture();
    store.commit(command());
    const bumped = new OrchestrationEventStore(db, project, "runtime-1", clock, null, ORCHESTRATION_V2_PROJECTION_VERSION + 1);
    expect(bumped.verify()).toMatchObject({ valid: false, schemaVersion: ORCHESTRATION_V2_PROJECTION_VERSION,
      expectedSchemaVersion: ORCHESTRATION_V2_PROJECTION_VERSION + 1 });
    bumped.rebuildProjections();
    expect(bumped.verify()).toMatchObject({ valid: true, schemaVersion: ORCHESTRATION_V2_PROJECTION_VERSION + 1 });
    expect(store.verify().valid).toBe(false);
    expect(bumped.projection("test", "thread-1")?.value).toEqual({ value: 1 });
    expect(() => new OrchestrationEventStore(db, project, "runtime-1", clock, null, -1)).toThrow("projection version");
  });

  it("rebuilds runtime projections after a version bump and reproduces every read", async () => {
    const runtime = await completedRuntime();
    const db = storeDatabase(runtime.store);
    const before = entities(db);
    expect(before.length).toBeGreaterThan(0);
    expect(runtime.store.orchestration.maintainProjections()).toMatchObject({ valid: true, rebuilt: false });
    const bumped = new OrchestratedTurnRepository(db, runtime.store, "runtime-bumped", null,
      ORCHESTRATION_V2_PROJECTION_VERSION + 1);
    expect(bumped.events.verify()).toMatchObject({ valid: false, schemaVersion: ORCHESTRATION_V2_PROJECTION_VERSION });
    expect(bumped.maintainProjections()).toMatchObject({ valid: true, rebuilt: true,
      schemaVersion: ORCHESTRATION_V2_PROJECTION_VERSION + 1 });
    expect(entities(db)).toEqual(before);
    expect(bumped.maintainProjections().rebuilt).toBe(false);
    expect(runtime.store.orchestration.maintainProjections()).toMatchObject({ valid: true, rebuilt: true,
      schemaVersion: ORCHESTRATION_V2_PROJECTION_VERSION });
    expect(entities(db)).toEqual(before);
    runtime.store.close();
  });

  it("detects and repairs missing threads and unreadable attempts", async () => {
    const runtime = await completedRuntime();
    const db = storeDatabase(runtime.store);
    const events = runtime.store.orchestration.events;
    const before = entities(db);
    db.prepare("DELETE FROM orchestration_v2_entities WHERE kind = 'thread' AND id = ?").run(runtime.conversationId);
    expect(events.verify()).toMatchObject({ valid: false, missingThreadIds: [runtime.conversationId],
      unexpectedThreadIds: [], unreadable: [] });
    expect(runtime.store.orchestration.maintainProjections()).toMatchObject({ valid: true, rebuilt: true,
      beforeRebuild: { valid: false, missingThreadIds: [runtime.conversationId] } });
    expect(entities(db)).toEqual(before);

    const attempt = db.prepare("SELECT id FROM orchestration_v2_entities WHERE kind = 'attempt'").get() as { id: string };
    db.prepare(`UPDATE orchestration_v2_entities SET payload_json = json_set(payload_json, '$.cleanup', 'bogus')
      WHERE kind = 'attempt' AND id = ?`).run(attempt.id);
    expect(events.verify()).toMatchObject({ valid: true, unreadable: [] });
    expect(events.verify({ readable: true })).toMatchObject({ valid: false,
      unreadable: [{ kind: "attempt", id: attempt.id }] });
    expect(events.verify({ readable: (kind) => kind !== "attempt" })).toMatchObject({ valid: false,
      unreadable: [{ kind: "attempt", id: attempt.id }] });
    expect(runtime.store.orchestration.maintainProjections()).toMatchObject({ valid: true, rebuilt: false,
      beforeRebuild: null });
    db.prepare("UPDATE orchestration_v2_projection_metadata SET last_sequence = last_sequence - 1").run();
    expect(runtime.store.orchestration.maintainProjections()).toMatchObject({ valid: true, rebuilt: true,
      unreadable: [], beforeRebuild: { valid: false, unreadable: [{ kind: "attempt", id: attempt.id }] } });
    expect(entities(db)).toEqual(before);

    db.prepare(`INSERT INTO orchestration_v2_entities (kind, id, project_id, thread_id, revision, payload_json)
      VALUES ('thread', 'stray-thread', 'stray-project', 'stray-thread', 1, '{}')`).run();
    expect(events.verify()).toMatchObject({ valid: false, unexpectedThreadIds: ["stray-thread"] });
    expect(runtime.store.orchestration.maintainProjections().rebuilt).toBe(true);
    expect(entities(db)).toEqual(before);
    expect(() => new OrchestrationEventStore(db, project, "runtime-1").verify({ readable: true }))
      .toThrow("No orchestration projection reader is configured.");
    runtime.store.close();
  });

  it("raises a typed startup blocker when a rebuild still leaves an unreadable row", async () => {
    const runtime = await completedRuntime();
    const db = storeDatabase(runtime.store);
    const orchestration = runtime.store.orchestration;
    const attempt = db.prepare("SELECT id FROM orchestration_v2_entities WHERE kind = 'attempt'").get() as { id: string };
    db.prepare("UPDATE orchestration_v2_projection_metadata SET schema_version = 0").run();
    rejectAttempt(attempt.id);
    const rebuild = vi.spyOn(orchestration.delegation, "rebuildProjections");
    let failure: unknown;
    try {
      orchestration.maintainProjections();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OrchestrationProjectionVerificationError);
    expect(failure).toBeInstanceOf(RuntimeStartupBlockerError);
    expect(failure).toMatchObject({ blockerCode: "orchestration-projection-invalid", verification: {
      valid: false, schemaVersion: ORCHESTRATION_V2_PROJECTION_VERSION, unreadable: [{ kind: "attempt", id: attempt.id }] } });
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(metadata(db).schema_version).toBe(ORCHESTRATION_V2_PROJECTION_VERSION);
    runtime.store.close();
  });
});

function rejectAttempt(attemptId: string): void {
  const safeParse = orchestrationAttemptSchema.safeParse.bind(orchestrationAttemptSchema);
  vi.spyOn(orchestrationAttemptSchema, "safeParse").mockImplementation(((value: unknown) => safeParse(
    value !== null && typeof value === "object" && (value as { id?: unknown }).id === attemptId ? {} : value,
  )) as typeof orchestrationAttemptSchema.safeParse);
}

const SCAN_STATEMENT = /SELECT id, payload_json FROM orchestration_v2_entities\s+WHERE kind = \? AND id > \?/u;

function scanStatements(prepare: { mock: { calls: unknown[][] } }): number {
  return prepare.mock.calls.filter(([sql]) => typeof sql === "string" && SCAN_STATEMENT.test(sql)).length;
}

describe("Orchestrator V2 boot-time projection maintenance", () => {
  it("does not parse projection rows when a clean database opens", async () => {
    const runtime = await completedRuntime();
    const path = join(runtime.directory, "inertia.sqlite");
    runtime.store.close();
    const prepare = vi.spyOn(Database.prototype, "prepare");
    const parses = [orchestrationThreadSchema, orchestrationRunSchema, orchestrationAttemptSchema]
      .map((schema) => vi.spyOn(schema, "safeParse"));
    const clean = new RuntimeStore(path, runtime.workspace, { recoverInterruptedRuns: false });
    clean.close();
    expect(scanStatements(prepare)).toBe(0);
    for (const parse of parses) expect(parse).not.toHaveBeenCalled();

    const tamper = new Database(path);
    tamper.prepare("UPDATE orchestration_v2_projection_metadata SET schema_version = 0").run();
    tamper.close();
    prepare.mockClear();
    const repaired = new RuntimeStore(path, runtime.workspace, { recoverInterruptedRuns: false });
    repaired.close();
    expect(scanStatements(prepare)).toBeGreaterThan(0);
    expect(parses[2]).toHaveBeenCalled();
  });

  it("refuses to open with a typed blocker when a rebuild leaves an unreadable row", async () => {
    const runtime = await completedRuntime();
    const path = join(runtime.directory, "inertia.sqlite");
    const attempt = storeDatabase(runtime.store).prepare("SELECT id FROM orchestration_v2_entities WHERE kind = 'attempt'")
      .get() as { id: string };
    runtime.store.close();
    const tamper = new Database(path);
    tamper.prepare("UPDATE orchestration_v2_projection_metadata SET last_sequence = 0").run();
    tamper.close();
    rejectAttempt(attempt.id);
    let failure: unknown;
    try {
      new RuntimeStore(path, runtime.workspace, { recoverInterruptedRuns: false }).close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OrchestrationProjectionVerificationError);
    expect(runtimeStartupErrorEvent(failure, "initialization")).toEqual({
      type: "runtime.startup-failed",
      message: "The orchestration projection could not be rebuilt from saved history.",
      blockerCode: "orchestration-projection-invalid",
    });
    vi.restoreAllMocks();
    const reopened = new RuntimeStore(path, runtime.workspace, { recoverInterruptedRuns: false });
    expect(metadata(storeDatabase(reopened)).last_sequence).toBeGreaterThan(0);
    reopened.close();
  });

  it("rebuilds tampered projections and the delegated task index when the store opens", async () => {
    const fixture = await createDelegationFixture();
    const path = join(fixture.runtime.directory, "inertia.sqlite");
    const source = fixture.queue(fixture.parentId, "Delegate the investigation");
    const { task, childTurn } = fixture.delegate(source, { wake: "settled_only" });
    fixture.close();

    const clean = new RuntimeStore(path, fixture.runtime.workspace, { recoverInterruptedRuns: false });
    const stored = clean.orchestration.delegation.get(task.taskId);
    expect(stored).toMatchObject({ taskId: task.taskId, turnIds: [childTurn.id] });
    const untouched = metadata(storeDatabase(clean));
    clean.close();
    const reopenedClean = new Database(path);
    expect(metadata(reopenedClean)).toEqual(untouched);
    const before = entities(reopenedClean);
    const index = reopenedClean.prepare("SELECT * FROM delegated_tasks ORDER BY task_id").all();
    const turns = reopenedClean.prepare("SELECT * FROM delegated_task_turns ORDER BY child_turn_id").all();
    expect(index).toHaveLength(1);
    expect(turns).toEqual([{ child_turn_id: childTurn.id, task_id: task.taskId }]);

    reopenedClean.prepare("UPDATE orchestration_v2_projection_metadata SET schema_version = 0").run();
    reopenedClean.prepare("DELETE FROM delegated_task_turns").run();
    reopenedClean.prepare("DELETE FROM delegated_tasks").run();
    reopenedClean.prepare("DELETE FROM orchestration_v2_entities WHERE kind = 'thread'").run();
    reopenedClean.close();

    const reopened = new RuntimeStore(path, fixture.runtime.workspace, { recoverInterruptedRuns: false });
    try {
      const db = storeDatabase(reopened);
      expect(metadata(db)).toMatchObject({ schema_version: ORCHESTRATION_V2_PROJECTION_VERSION,
        last_sequence: (db.prepare("SELECT MAX(sequence) AS sequence FROM orchestration_v2_events").get() as
          { sequence: number }).sequence });
      expect(entities(db)).toEqual(before);
      expect(db.prepare("SELECT * FROM delegated_tasks ORDER BY task_id").all()).toEqual(index);
      expect(db.prepare("SELECT * FROM delegated_task_turns ORDER BY child_turn_id").all()).toEqual(turns);
      expect(reopened.orchestration.delegation.get(task.taskId)).toEqual(stored);
      expect(reopened.orchestration.maintainProjections().rebuilt).toBe(false);
    } finally {
      reopened.close();
    }
  });
});

describe("Orchestrator V2 receipt status migration", () => {
  async function databaseAt(version: 110 | 112) {
    const runtime = await completedRuntime();
    const orchestration = runtime.store.orchestration;
    const conversation = runtime.store.conversation(runtime.conversationId);
    orchestration.events.commit({ actorId: "human", commandId: "request-before-113", projectId: conversation.projectId,
      threadId: conversation.id, command: { type: "conversation.noop" }, expectedRevision: orchestration.events.revision(conversation.id),
      events: [], result: { kept: true } });
    const path = join(runtime.directory, "inertia.sqlite");
    runtime.store.close();
    const db = new Database(path);
    databases.push(db);
    db.pragma("foreign_keys = ON");
    db.exec(`
      DROP TABLE orchestration_v2_projection_metadata;
      ALTER TABLE orchestration_v2_receipts DROP COLUMN command_type;
      ALTER TABLE orchestration_v2_receipts DROP COLUMN error;
      ALTER TABLE orchestration_v2_receipts DROP COLUMN status;
    `);
    db.prepare("DELETE FROM schema_migrations WHERE version > 112").run();
    if (version === 110) removeDelegatedTasksFromFixture(db);
    expect((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
      .toBe(version);
    return { runtime, db, path, entities: entities(db), receipts: receipts(db) };
  }

  it.each([112, 110] as const)("upgrades a schema %i database and preserves its receipts", async (version) => {
    const { runtime, db, path, entities: beforeEntities, receipts: beforeReceipts } = await databaseAt(version);
    expect(beforeReceipts.length).toBeGreaterThanOrEqual(2);
    migrateRuntimeDatabase(db);
    expect((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
      .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    expect(receipts(db)).toEqual(beforeReceipts);
    expect(db.prepare("SELECT DISTINCT status, error, command_type FROM orchestration_v2_receipts").all())
      .toEqual([{ status: "accepted", error: null, command_type: null }]);
    const seeded = metadata(db);
    expect(seeded).toMatchObject({ schema_version: 1, last_sequence: (db.prepare(
      "SELECT MAX(sequence) AS sequence FROM orchestration_v2_events").get() as { sequence: number }).sequence });
    expect(seeded.last_sequence).toBeGreaterThan(0);
    expect(new OrchestrationEventStore(db, projectOrchestrationEvent, "runtime-check").verify().valid).toBe(true);
    db.close();

    const reopened = new RuntimeStore(path, runtime.workspace, { recoverInterruptedRuns: false });
    try {
      const reopenedDb = storeDatabase(reopened);
      expect(metadata(reopenedDb)).toEqual(seeded);
      expect(entities(reopenedDb)).toEqual(beforeEntities);
      const conversation = reopened.conversation(runtime.conversationId);
      const identity = { actorId: "human", commandId: "request-before-113", projectId: conversation.projectId,
        threadId: conversation.id };
      expect(reopened.orchestration.events.receipt(identity, { type: "conversation.noop" })).toMatchObject({
        status: "accepted", error: null, commandType: null, result: { kept: true } });
      expect(() => reopened.orchestration.events.receipt(identity, { type: "conversation.other" })).toThrow("command-conflict");
    } finally {
      reopened.close();
    }
  });

  it("is a no-op when migration 113 runs again", async () => {
    const runtime = await completedRuntime();
    const path = join(runtime.directory, "inertia.sqlite");
    runtime.store.close();
    const db = new Database(path);
    databases.push(db);
    db.pragma("foreign_keys = ON");
    const schema = () => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const beforeSchema = schema();
    const beforeMetadata = metadata(db);
    const beforeReceipts = db.prepare("SELECT * FROM orchestration_v2_receipts ORDER BY actor_id, command_id").all();
    migrateReceiptStatus(db);
    db.prepare("DELETE FROM schema_migrations WHERE version = 113").run();
    migrateRuntimeDatabase(db);
    expect(schema()).toEqual(beforeSchema);
    expect(metadata(db)).toEqual(beforeMetadata);
    expect(db.prepare("SELECT * FROM orchestration_v2_receipts ORDER BY actor_id, command_id").all()).toEqual(beforeReceipts);
    expect((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
      .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
  });

  it("rejects receipt values outside the migrated bounds", () => {
    const { db } = fixture();
    const insert = (status: string, error: string | null, commandType: string | null) => db.prepare(`INSERT INTO
      orchestration_v2_receipts (actor_id, command_id, thread_id, project_id, fingerprint, result_json, created_at,
      status, error, command_type) VALUES ('human', ?, 'thread-1', 'project-1', 'f', 'null', 'now', ?, ?, ?)`)
      .run(`${status}-${String(error?.length)}-${String(commandType?.length)}`, status, error, commandType);
    expect(() => insert("pending", null, null)).toThrow(/CHECK/u);
    expect(() => insert("rejected", "x".repeat(1_001), null)).toThrow(/CHECK/u);
    expect(() => insert("rejected", null, "y".repeat(241))).toThrow(/CHECK/u);
    expect(() => insert("rejected", "x".repeat(1_000), "y".repeat(240))).not.toThrow();
    expect(() => db.prepare(`INSERT INTO orchestration_v2_projection_metadata VALUES ('other', 1, 0, 'now')`).run())
      .toThrow(/CHECK/u);
  });
});
