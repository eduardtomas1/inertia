import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { deflateRawSync } from "node:zlib";

import Database from "better-sqlite3";
import { afterAll, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { conversationAttachmentGallery } from "../../src/server/persistence/conversation-attachment-gallery";
import {
  conversationStoredBytes,
  historyStoredBytes,
  selectConversationHistory,
} from "../../src/server/persistence/conversation-history";
import type { ConversationDetail } from "../../src/shared/contracts";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import type { ConversationHistoryRequest } from "../../src/shared/conversation-history";
import { distribution } from "../helpers/desktop-benchmark-summary";
import {
  CONTENT_LOADING_CHAT_MESSAGES,
  initializeContentLoadingWorkspace,
  seedContentLoadingRuntime,
} from "../helpers/content-loading-fixture";

const SAMPLES = Number(process.env.INERTIA_CONTENT_BENCHMARK_SAMPLES ?? 7);
const reportPath = resolve(process.env.INERTIA_CONTENT_BENCHMARK_REPORT
  ?? `performance-results/content-loading-server-${process.platform}-${process.arch}.json`);
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function time<T>(operation: () => T): { result: T; ms: number } {
  const startedAt = performance.now();
  const result = operation();
  return { result, ms: performance.now() - startedAt };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fieldBytes(detail: ConversationDetail): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const [key, value] of Object.entries(detail)) fields[key] = bytes(value);
  fields["activities.detail"] = detail.activities.reduce((total, activity) =>
    total + Buffer.byteLength(JSON.stringify(activity.detail ?? null), "utf8"), 0);
  fields["messages.content"] = detail.messages.reduce((total, message) =>
    total + Buffer.byteLength(JSON.stringify(message.content), "utf8"), 0);
  fields["reasonings.content"] = detail.reasonings.reduce((total, reasoning) =>
    total + Buffer.byteLength(JSON.stringify(reasoning.content), "utf8"), 0);
  return fields;
}

function frame(conversationId: string, detail: ConversationDetail): string {
  return JSON.stringify({ type: "request.result", requestId: "benchmark",
    result: { kind: "conversation.detail", conversationId, state: "ready", detail } });
}

function pageSample(store: RuntimeStore, database: Database.Database, conversationId: string,
  history: ConversationHistoryRequest) {
  const total = time(() => store.conversationHistory(conversationId, history));
  const detail = total.result!;
  const latest = !history.before;
  const scope = time(() => selectConversationHistory(database, conversationId, history));
  const stored = time(() => historyStoredBytes(database, conversationId, scope.result));
  const conversationBytes = latest ? time(() => conversationStoredBytes(database, conversationId)).ms : 0;
  const gallery = time(() => conversationAttachmentGallery(database, conversationId));
  const sizeCheck = time(() => Buffer.byteLength(JSON.stringify(detail), "utf8"));
  const serialized = time(() => frame(conversationId, detail));
  const parsed = time(() => JSON.parse(serialized.result) as unknown);
  const validated = time(() => parseServerEvent(parsed.result));
  const deflated = time(() => deflateRawSync(serialized.result, { level: 1 }));
  return {
    totalMs: total.ms,
    phases: {
      selectUnitsMs: scope.ms,
      historyStoredBytesMs: stored.ms,
      conversationStoredBytesMs: conversationBytes,
      attachmentGalleryMs: gallery.ms,
      sizeCheckStringifyMs: sizeCheck.ms,
      recordsAndDecodeMs: Math.max(0, total.ms - scope.ms - stored.ms - conversationBytes - gallery.ms - sizeCheck.ms),
    },
    sendStringifyMs: serialized.ms,
    parseMs: parsed.ms,
    validateMs: validated.ms,
    deflateLevel1Ms: deflated.ms,
    frameBytes: Buffer.byteLength(serialized.result, "utf8"),
    deflatedBytes: deflated.result.byteLength,
    units: scope.result.units.length,
    counts: { turns: detail.agentTurns.length, messages: detail.messages.length, activities: detail.activities.length,
      reasonings: detail.reasonings.length, attachments: detail.messages.reduce((total, message) => total + message.attachments.length, 0) },
    fields: fieldBytes(detail),
    older: detail.history?.older ?? null,
  };
}

function explain(database: Database.Database, conversationId: string): Record<string, string[]> {
  const scope = selectConversationHistory(database, conversationId);
  const plan = (sql: string, ...parameters: unknown[]) =>
    (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[]).map(({ detail }) => detail);
  const units = `SELECT * FROM (SELECT id, requested_at AS at, 'turn' AS kind FROM agent_turns WHERE conversation_id = ?
    UNION ALL SELECT id, created_at AS at, 'message' AS kind FROM messages WHERE conversation_id = ? AND turn_id IS NULL)
    WHERE (at, id, kind) < (?, ?, ?) ORDER BY at DESC, id DESC, kind DESC LIMIT ?`;
  const turnIds = scope.units.map(({ id }) => id);
  const inList = turnIds.map(() => "?").join(",");
  const older = scope.older!;
  return {
    olderUnits: plan(units, conversationId, conversationId, older.at, older.id, older.kind, 41),
    messagesForPage: plan(`SELECT id FROM messages WHERE conversation_id = ? AND (turn_id IN (${inList}) OR 0) ORDER BY created_at, id`,
      conversationId, ...turnIds),
    activitiesForPage: plan(`SELECT * FROM activities WHERE (activities.conversation_id = ? AND activities.turn_id IN (${inList}))
      OR (activities.conversation_id = ? AND activities.turn_id IS NULL AND activities.created_at >= ?) ORDER BY created_at, id`,
    conversationId, ...turnIds, conversationId, older.at),
    attachmentGallery: plan(`SELECT message.id FROM messages AS message INDEXED BY messages_conversation_created_idx,
      json_each(CASE WHEN json_valid(message.attachments_json) THEN message.attachments_json ELSE '[]' END) AS item
      WHERE message.conversation_id = ? AND message.role = 'user' ORDER BY message.created_at DESC`, conversationId),
  };
}

it("records server-side history page, payload and snapshot costs", async () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-content-benchmark-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  await mkdir(workspace, { recursive: true });
  await initializeContentLoadingWorkspace(workspace);
  const seedStartedAt = performance.now();
  const fixture = await seedContentLoadingRuntime(dataDirectory, workspace);
  const seedMs = performance.now() - seedStartedAt;
  const databasePath = join(dataDirectory, "inertia.sqlite");
  const report: Record<string, unknown> = { samples: SAMPLES, platform: `${process.platform}-${process.arch}`,
    node: process.version, fixture, chats: {} };
  for (const size of CONTENT_LOADING_CHAT_MESSAGES) {
    const chat = fixture.chats[size];
    const coldStore = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
    const cold = time(() => coldStore.conversationHistory(chat.id));
    coldStore.close();
    const store = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
    const database = new Database(databasePath, { readonly: true });
    try {
      const latest = Array.from({ length: SAMPLES }, () => pageSample(store, database, chat.id, {}));
      const pages: ReturnType<typeof pageSample>[][] = [];
      let cursor = latest[0]!.older;
      while (cursor) {
        const before = cursor;
        const samples = Array.from({ length: SAMPLES }, () => pageSample(store, database, chat.id, { before }));
        pages.push(samples);
        cursor = samples[0]!.older;
      }
      const summarize = (samples: ReturnType<typeof pageSample>[]) => ({
        totalMs: distribution(samples.map(({ totalMs }) => totalMs)),
        phasesMedianMs: Object.fromEntries(Object.keys(samples[0]!.phases).map((key) => [key,
          distribution(samples.map(({ phases }) => phases[key as keyof typeof phases])).median])),
        sendStringifyMs: distribution(samples.map(({ sendStringifyMs }) => sendStringifyMs)),
        parseMs: distribution(samples.map(({ parseMs }) => parseMs)),
        validateMs: distribution(samples.map(({ validateMs }) => validateMs)),
        deflateLevel1Ms: distribution(samples.map(({ deflateLevel1Ms }) => deflateLevel1Ms)),
        frameBytes: samples[0]!.frameBytes,
        deflatedBytes: samples[0]!.deflatedBytes,
        units: samples[0]!.units,
        counts: samples[0]!.counts,
        fields: samples[0]!.fields,
        rawTotalMs: samples.map(({ totalMs }) => Number(totalMs.toFixed(3))),
      });
      (report.chats as Record<string, unknown>)[size] = {
        turns: chat.turns,
        coldFirstOpenMs: cold.ms,
        latest: summarize(latest),
        olderPages: pages.map(summarize),
        explain: pages.length ? explain(database, chat.id) : null,
      };
    } finally {
      database.close();
      store.close();
    }
  }
  const store = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
  try {
    const shell = Array.from({ length: SAMPLES }, () => time(() => store.shellSnapshot()));
    const snapshot = shell[0]!.result;
    const archived = snapshot.conversations.filter(({ archivedAt }) => archivedAt !== null);
    const snapshotFrame = JSON.stringify({ type: "snapshot.updated", snapshot });
    const snapshotDecode = Array.from({ length: SAMPLES }, () => {
      const parsed = time(() => JSON.parse(snapshotFrame) as unknown);
      const validated = time(() => parseServerEvent(parsed.result));
      return { parseMs: parsed.ms, validateMs: validated.ms };
    });
    report.shellSnapshot = {
      ms: distribution(shell.map(({ ms }) => ms)),
      rawMs: shell.map(({ ms }) => Number(ms.toFixed(3))),
      bytes: bytes(snapshot),
      fields: Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, bytes(value)])),
      conversations: snapshot.conversations.length,
      archivedConversations: archived.length,
      archivedConversationBytes: bytes(archived),
      bytesPerConversation: Math.round(bytes(snapshot.conversations) / snapshot.conversations.length),
      parseMs: distribution(snapshotDecode.map(({ parseMs }) => parseMs)),
      validateMs: distribution(snapshotDecode.map(({ validateMs }) => validateMs)),
    };
  } finally {
    store.close();
  }
  report.seedMs = seedMs;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Content loading server report: ${reportPath}`);
  expect(Object.keys(report.chats as object)).toHaveLength(CONTENT_LOADING_CHAT_MESSAGES.length);
});
