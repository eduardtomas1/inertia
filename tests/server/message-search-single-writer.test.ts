import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RuntimeStore } from "../../src/server/database";
import { runtimeDatabaseCompactionBlocker } from "../../src/server/persistence/database-compaction";
import { searchMessages } from "../../src/server/persistence/message-search";
import { DatabaseWriteGate } from "../../src/server/runtime/database-write-gate";
import {
  messageSearchIndexIdle,
  startMessageSearchIndexing,
  type MessageSearchIndexIdleState,
} from "../../src/server/runtime/message-search-indexing";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import type { ServerEvent } from "../../src/shared/contracts";
import { startTestRuntime } from "../support/test-runtime";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const idleState: MessageSearchIndexIdleState = {
  closed: false, safetyLocked: false, updatePreparing: false, recoveryActive: false, activeRuntimeCommands: 0,
  activeTurns: false, activeRuns: false, providerMaintenanceActive: false, backingUp: false, compacting: false,
};

function unindexedHistory(options: { messages: number; legacy?: boolean }): { directory: string; databasePath: string; conversationId: string } {
  const directory = mkdtempSync(join(tmpdir(), "inertia-search-single-writer-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "inertia.sqlite");
  const setup = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  const conversationId = setup.createConversation(setup.createProject("History", directory).id, "History").id;
  setup.close();
  const raw = new Database(databasePath);
  if (options.legacy) {
    raw.pragma("auto_vacuum = NONE");
    raw.exec("VACUUM");
  }
  const insert = raw.prepare("INSERT INTO messages (id, conversation_id, turn_id, role, content, attachments_json, created_at) VALUES (?, ?, NULL, 'user', ?, '[]', ?)");
  const filler = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo";
  raw.transaction(() => {
    for (let index = 0; index < options.messages; index += 1) {
      insert.run(`m-${String(index).padStart(7, "0")}`, conversationId, `history ${index} ${filler} ${index * 7}`, new Date(Date.UTC(2024, 0, 1) + index * 60_000).toISOString());
    }
  })();
  if (options.legacy) {
    raw.exec("CREATE TABLE ballast (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    const ballast = raw.prepare("INSERT INTO ballast (body) VALUES (?)");
    raw.transaction(() => { for (let index = 0; index < 400; index += 1) ballast.run("x".repeat(8_000)); })();
    raw.exec("DROP TABLE ballast");
  }
  raw.exec(`
    INSERT INTO message_search_index (message_search_index) VALUES ('delete-all');
    DELETE FROM message_search_documents;
    UPDATE message_search_backfill SET complete = 0, before_created_at = NULL, before_message_id = NULL;
  `);
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
  return { directory, databasePath, conversationId };
}

interface Slice { kind: "index" | "merge"; at: number; turnActive: boolean; backingUp: boolean; compacting: boolean }

function indexedRuntime(history: ReturnType<typeof unindexedHistory>) {
  const state = { turnActive: false };
  let gate!: DatabaseWriteGate;
  const store = new RuntimeStore(history.databasePath, history.directory, {
    recoverInterruptedRuns: false,
    databaseCompaction: {
      availableDiskBytes: () => 8 * 1024 ** 3,
      blockedReason: (mode) => runtimeDatabaseCompactionBlocker(mode, {
        closed: false, updatePreparing: false, recoveryActive: false, activeTurns: state.turnActive, activeRuns: false,
        providerMaintenanceActive: false, activeRuntimeCommands: 0, activeNonStorageCommands: 0, activeProviderRefreshes: 0,
        activeBackgroundWrites: gate.activeWrites(),
      }),
    },
  });
  gate = new DatabaseWriteGate({ isDatabaseVacuuming: () => store.isDatabaseVacuuming(), whenDatabaseWritable: () => store.whenDatabaseWritable() });
  const controller = new AbortController();
  const reader = new Database(history.databasePath, { readonly: true });
  reader.pragma("mmap_size = 0");
  cleanup.push(async () => {
    controller.abort();
    reader.close();
    store.close();
  });
  const slices: Slice[] = [];
  const failures: unknown[] = [];
  const record = (kind: Slice["kind"]): void => {
    slices.push({ kind, at: performance.now(), turnActive: state.turnActive, backingUp: store.isDatabaseBackingUp(), compacting: store.isDatabaseCompacting() });
  };
  const start = (): void => startMessageSearchIndexing({
    signal: controller.signal, writes: gate,
    index: (budgetMs) => { record("index"); return store.indexMessageSearchBatch(budgetMs); },
    merge: (budgetMs) => { record("merge"); return store.mergeMessageSearchIndex(budgetMs); },
    idle: () => messageSearchIndexIdle({ ...idleState, activeTurns: state.turnActive, backingUp: store.isDatabaseBackingUp(), compacting: store.isDatabaseCompacting() }),
    onFailure: (error) => failures.push(error),
    delays: { start: 0, busy: 5, settled: 20 },
  });
  const indexed = (): number => reader.prepare("SELECT count(*) FROM message_search_documents").pluck().get() as number;
  const backfillComplete = (): boolean => reader.prepare("SELECT complete FROM message_search_backfill").pluck().get() === 1;
  return { store, reader, gate, state, slices, failures, start, indexed, backfillComplete };
}

async function until(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("message search indexing on the runtime's only writer connection", () => {
  it("streams a whole turn while backfill is pending without indexing or a busy error, then indexes once idle", async () => {
    const history = unindexedHistory({ messages: 2_000 });
    const runtime = indexedRuntime(history);
    runtime.state.turnActive = true;
    runtime.start();
    const user = runtime.store.createMessage(history.conversationId, "Please stream", "user");
    const turn = runtime.store.createAgentTurn({
      id: randomUUID(), conversationId: history.conversationId, runId: randomUUID(), userMessageId: user.id,
      providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
      model: "test", reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
      configurationRevision: 0, association: "authoritative",
    });
    const answer = runtime.store.createMessage(history.conversationId, "streamed", "assistant", [], turn.id);
    for (let chunk = 0; chunk < 120; chunk += 1) {
      runtime.store.appendMessageContent(answer.id, ` chunk-${chunk}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    runtime.store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalAssistantMessageId: answer.id, terminalReason: "provider-completed" });
    expect(runtime.slices).toEqual([]);
    expect(runtime.indexed()).toBe(2);
    runtime.state.turnActive = false;
    await until(runtime.backfillComplete);
    expect(runtime.failures).toEqual([]);
    expect(runtime.slices.every(({ turnActive }) => !turnActive)).toBe(true);
    expect(runtime.indexed()).toBe(2_002);
    expect(searchMessages(runtime.reader, "chunk-119").hits.map(({ messageId }) => messageId)).toEqual([answer.id]);
    expect(searchMessages(runtime.reader, "history 1999 ").hits).toHaveLength(1);
    expect(searchMessages(runtime.reader, "Please stream").hits.map(({ messageId }) => messageId)).toEqual([user.id]);
  });

  it("finishes a backup started while backfill is running and pauses indexing until it ends", async () => {
    const history = unindexedHistory({ messages: 40_000 });
    const runtime = indexedRuntime(history);
    runtime.start();
    await until(() => runtime.indexed() > 0);
    const backup = runtime.store.createBackup();
    expect(runtime.store.isDatabaseBackingUp()).toBe(true);
    expect(runtime.backfillComplete()).toBe(false);
    const result = await backup;
    expect(result.size).toBeGreaterThan(0);
    expect(runtime.store.isDatabaseBackingUp()).toBe(false);
    await until(runtime.backfillComplete, 60_000);
    expect(runtime.failures).toEqual([]);
    expect(runtime.slices.some(({ backingUp }) => backingUp)).toBe(false);
    expect(runtime.indexed()).toBe(40_000);
  }, 90_000);

  it("compacts and shrinks the file on request during backfill, pausing indexing around the VACUUM and resuming after it", async () => {
    const history = unindexedHistory({ messages: 40_000, legacy: true });
    const runtime = indexedRuntime(history);
    runtime.start();
    await until(() => runtime.indexed() > 0);
    expect(runtime.backfillComplete()).toBe(false);
    const sizeBefore = statSync(history.databasePath).size;
    const startedAt = performance.now();
    const { compaction, storage } = await runtime.store.compactDatabase();
    const endedAt = performance.now();
    expect(compaction.mode).toBe("full-vacuum");
    expect(storage.autoVacuum).toBe("incremental");
    expect(statSync(history.databasePath).size).toBeLessThan(sizeBefore - 2 * 1024 * 1024);
    expect(runtime.slices.filter(({ at }) => at > startedAt && at < endedAt)).toEqual([]);
    expect(runtime.backfillComplete()).toBe(false);
    await until(runtime.backfillComplete, 60_000);
    expect(runtime.slices.some(({ at }) => at > endedAt)).toBe(true);
    expect(runtime.slices.some(({ compacting }) => compacting)).toBe(false);
    expect(runtime.failures).toEqual([]);
    expect(runtime.indexed()).toBe(40_000);
    expect(searchMessages(runtime.reader, "history 39999 ").hits).toHaveLength(1);
  }, 120_000);

  it("never refuses Compact now over the runtime boundary because the indexer is working", async () => {
    const history = unindexedHistory({ messages: 40_000, legacy: true });
    const previous = process.env.INERTIA_TEST_MESSAGE_SEARCH_INDEX_START_MS;
    process.env.INERTIA_TEST_MESSAGE_SEARCH_INDEX_START_MS = "0";
    cleanup.push(() => {
      if (previous === undefined) delete process.env.INERTIA_TEST_MESSAGE_SEARCH_INDEX_START_MS;
      else process.env.INERTIA_TEST_MESSAGE_SEARCH_INDEX_START_MS = previous;
    });
    const runtime = await startTestRuntime({
      dataDirectory: history.directory,
      defaultWorkspacePath: history.directory,
      enableProviders: false,
      runtimeGenerationId: `${randomUUID()}:1`,
      systemBootId: `test:${randomUUID()}`,
    });
    cleanup.push(() => runtime.close());
    const reader = new Database(history.databasePath, { readonly: true });
    reader.pragma("mmap_size = 0");
    cleanup.push(() => { reader.close(); });
    const indexed = (): number => reader.prepare("SELECT count(*) FROM message_search_documents").pluck().get() as number;
    const socket = new WebSocket(runtime.websocketUrl, { origin: "http://localhost:5173" });
    cleanup.push(() => socket.close());
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once("open", () => resolveOpen());
      socket.once("error", rejectOpen);
    });
    const request = (type: "database.storage.compact"): Promise<ServerEvent> => new Promise<ServerEvent>((resolveEvent, rejectEvent) => {
      const requestId = randomUUID();
      const onMessage = (raw: WebSocket.RawData): void => {
        const event = parseServerEvent(JSON.parse(raw.toString("utf8")));
        if (!event) { socket.off("message", onMessage); rejectEvent(new Error("Invalid server event payload.")); return; }
        if ((event.type === "request.result" || event.type === "request.error") && event.requestId === requestId) {
          socket.off("message", onMessage);
          resolveEvent(event);
        }
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ requestId, type }));
    });
    await until(() => indexed() > 0, 60_000);
    const sizeBefore = statSync(history.databasePath).size;
    expect(indexed()).toBeLessThan(40_000);
    const compacted = await request("database.storage.compact");
    if (compacted.type !== "request.result" || compacted.result.kind !== "database.storage") {
      throw new Error(`Compaction was refused: ${JSON.stringify(compacted)}`);
    }
    expect(compacted.result.compaction?.mode).toBe("full-vacuum");
    expect(statSync(history.databasePath).size).toBeLessThan(sizeBefore - 2 * 1024 * 1024);
    await until(() => reader.prepare("SELECT complete FROM message_search_backfill").pluck().get() === 1, 90_000);
    expect(indexed()).toBe(40_000);
  }, 150_000);
});
