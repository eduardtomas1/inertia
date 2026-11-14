import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import {
  DEFAULT_WATCHER_BUDGETS,
  DEFAULT_WATCHER_SHARING,
  MAX_WATCHER_LABEL_CHARS,
  watcherNoteAttributionSchema,
} from "../../src/shared/watcher";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const directories: string[] = [];
const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const turnId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userMessageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const note = {
  linkId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  wakeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  watcherConversationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  preset: "reviewer",
  watcherLabel: "Reviewer",
  delivery: "queue",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type Row = Record<string, unknown>;

function cloneRow(database: Database.Database, table: string, sourceId: string, overrides: Row): void {
  const source = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(sourceId) as Row;
  const row = { ...source, ...overrides };
  const columns = Object.keys(row);
  database.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`)
    .run(row);
}

const rows = (database: Database.Database, sql: string): Row[] => database.prepare(sql).all() as Row[];
const withoutNote = (entries: Row[]): Row[] => entries.map(({ watcher_note_json: _note, duo_comparison_json: _duo, custom_agent_call_json: _call, secret_request_json: _secret, ...row }) => row);

async function schema98Database() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-watcher-migration-"));
  directories.push(directory);
  const databasePath = join(directory, "published.sqlite");
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  await copyFile(fixture, databasePath);
  const database = new Database(databasePath);
  try {
    migrateRuntimeDatabase(database, 98);
    database.pragma("foreign_keys = ON");
    cloneRow(database, "conversations", "fixture-conversation-006", { id: conversationId, title: "Seeded schema-98 chat" });
    cloneRow(database, "messages", "message-user-1-006", { id: userMessageId, conversation_id: conversationId, turn_id: null });
    cloneRow(database, "agent_turns", "legacy-turn-f46cba6c0f9277950f4e4ab56fea4bf7", {
      id: turnId, conversation_id: conversationId, run_id: "run-seeded-98", user_message_id: userMessageId,
      terminal_assistant_message_id: null, checkpoint_id: null,
    });
    database.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(turnId, userMessageId);
    const insertRead = database.prepare(`
      INSERT INTO agent_context_reads (
        id, target_conversation_id, target_turn_id, target_user_message_id, source_conversation_id,
        source_conversation_title, source_turn_id, access, page_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:01.000Z')
    `);
    insertRead.run("11111111-0000-4000-8000-000000000001", conversationId, turnId, userMessageId, conversationId, "Seeded schema-98 chat", null, "own", 1);
    insertRead.run("11111111-0000-4000-8000-000000000002", conversationId, turnId, userMessageId, "22222222-0000-4000-8000-000000000002", "Referenced chat", "turn-r", "referenced", 2);
    insertRead.run("11111111-0000-4000-8000-000000000003", conversationId, turnId, userMessageId, "22222222-0000-4000-8000-000000000003", "Approved chat", null, "approved", 3);
    database.prepare(`
      INSERT INTO queued_messages (id, conversation_id, content, attachments_json, intent_digest, route_identity, state, created_at)
      VALUES ('33333333-0000-4000-8000-000000000001', 'fixture-conversation-006', 'Queued at schema 98', '[]', ?, '[]', 'waiting', '2026-10-01T00:00:02.000Z')
    `).run("a".repeat(64));
    return {
      databasePath,
      workspacePath,
      messages: rows(database, "SELECT * FROM messages ORDER BY id"),
      queued: rows(database, "SELECT * FROM queued_messages ORDER BY sequence"),
      reads: rows(database, "SELECT * FROM agent_context_reads ORDER BY id"),
    };
  } finally {
    database.close();
  }
}

describe("watcher link migration", () => {
  it("upgrades a published database at schema 98 without changing existing rows", async () => {
    const before = await schema98Database();
    const store = new RuntimeStore(before.databasePath, before.workspacePath, { recoverInterruptedRuns: false });
    store.close();
    const migrated = new Database(before.databasePath);
    try {
      expect((migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(99);
      const messages = rows(migrated, "SELECT * FROM messages ORDER BY id");
      expect(withoutNote(messages)).toEqual(before.messages);
      expect(messages.every((row) => row.watcher_note_json === null)).toBe(true);
      expect(messages.every((row) => row.duo_comparison_json === null)).toBe(true);
      expect(messages.every((row) => row.custom_agent_call_json === null)).toBe(true);
      expect(messages.every((row) => row.secret_request_json === null)).toBe(true);
      const queued = rows(migrated, "SELECT * FROM queued_messages ORDER BY sequence");
      expect(withoutNote(queued)).toEqual(before.queued);
      expect(rows(migrated, "SELECT * FROM agent_context_reads ORDER BY id")).toEqual(before.reads);
      expect(rows(migrated, `
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'agent_context_reads' AND name NOT LIKE 'sqlite_%' ORDER BY name
      `)).toEqual([{ name: "agent_context_reads_identity_idx" }, { name: "agent_context_reads_target_idx" }]);
      expect(rows(migrated, "SELECT name FROM sqlite_master WHERE name LIKE 'agent_context_reads_v99%'")).toEqual([]);
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
      expect(migrated.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      migrated.close();
    }
  });

  it("accepts the watched access kind and the new attribution columns only within their checks", async () => {
    const before = await schema98Database();
    new RuntimeStore(before.databasePath, before.workspacePath, { recoverInterruptedRuns: false }).close();
    const migrated = new Database(before.databasePath);
    try {
      migrated.pragma("foreign_keys = ON");
      const read = migrated.prepare(`
        INSERT INTO agent_context_reads (
          id, target_conversation_id, target_turn_id, target_user_message_id, source_conversation_id,
          source_conversation_title, source_turn_id, access, page_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '44444444-0000-4000-8000-000000000001', 'Watched chat', NULL, ?, 1, 'now', 'now')
      `);
      expect(() => read.run("11111111-0000-4000-8000-000000000004", conversationId, turnId, userMessageId, "watched")).not.toThrow();
      expect(() => read.run("11111111-0000-4000-8000-000000000005", conversationId, turnId, userMessageId, "anyone"))
        .toThrow(/CHECK constraint failed/u);
      const setNote = migrated.prepare("UPDATE messages SET watcher_note_json = ? WHERE id = ?");
      expect(() => setNote.run(JSON.stringify(note), userMessageId)).not.toThrow();
      expect(() => setNote.run(JSON.stringify(note), "message-assistant-1a-006")).toThrow(/CHECK constraint failed/u);
      expect(() => setNote.run("not json", userMessageId)).toThrow(/CHECK constraint failed/u);
      expect(() => setNote.run("[]", userMessageId)).toThrow(/CHECK constraint failed/u);
      expect(() => setNote.run(JSON.stringify({ ...note, watcherLabel: "x".repeat(1_100) }), userMessageId))
        .toThrow(/CHECK constraint failed/u);
      for (const watcherLabel of ["界".repeat(MAX_WATCHER_LABEL_CHARS), "\"".repeat(MAX_WATCHER_LABEL_CHARS)]) {
        const widest = watcherNoteAttributionSchema.parse({
          ...note, preset: "scope-guard", delivery: "steer", providerId: "antigravity", watcherLabel, automatic: true,
        });
        expect(widest.automatic).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(widest), "utf8")).toBeLessThan(1_024);
        expect(() => setNote.run(JSON.stringify(widest), userMessageId)).not.toThrow();
        expect(() => migrated.prepare("UPDATE queued_messages SET watcher_note_json = ?").run(JSON.stringify(widest))).not.toThrow();
      }
      const setQueuedNote = migrated.prepare("UPDATE queued_messages SET watcher_note_json = ?");
      expect(() => setQueuedNote.run(JSON.stringify(note))).not.toThrow();
      expect(() => setQueuedNote.run("{")).toThrow(/CHECK constraint failed/u);
      expect(rows(migrated, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'watcher_%' ORDER BY name"))
        .toEqual([
          { name: "watcher_links_active_limit" },
          { name: "watcher_links_detached_final" },
          { name: "watcher_links_watched_delete" },
        ]);
    } finally {
      migrated.close();
    }
  });

  it("adds the watcher delivery policy and findings count with their defaults and checks in an upgraded database", async () => {
    const before = await schema98Database();
    const store = new RuntimeStore(before.databasePath, before.workspacePath, { recoverInterruptedRuns: false });
    try {
      const project = store.createProject("Upgraded project", before.workspacePath);
      const watched = store.createConversation(project.id, "Main chat");
      store.watcherLinks.createWithConversation({
        link: {
          id: note.linkId, watchedConversationId: watched.id, preset: "reviewer", instructions: "",
          sharing: { ...DEFAULT_WATCHER_SHARING }, budgets: { ...DEFAULT_WATCHER_BUDGETS }, privateConnect: "inherit",
        },
        conversation: { projectId: project.id, title: "Watcher · Reviewer · Main chat", options: { interactionMode: "plan", accessMode: "supervised" } },
      }, "2026-10-02T00:00:00.000Z");
    } finally {
      store.close();
    }
    const migrated = new Database(before.databasePath);
    try {
      const columns = (table: string) => new Map((migrated.pragma(`table_info(${table})`) as { name: string; notnull: number; dflt_value: string | null }[])
        .map(({ name, notnull, dflt_value }) => [name, { notnull, dflt_value }]));
      expect(columns("watcher_links").get("delivery")).toEqual({ notnull: 1, dflt_value: "'manual'" });
      expect(rows(migrated, "SELECT delivery FROM watcher_links")).toEqual([{ delivery: "manual" }]);
      const setDelivery = migrated.prepare("UPDATE watcher_links SET delivery = ?");
      expect(() => setDelivery.run("auto")).not.toThrow();
      expect(() => setDelivery.run("steer")).toThrow(/CHECK constraint failed/u);
      expect(() => setDelivery.run(null)).toThrow(/NOT NULL constraint failed/u);
      expect(columns("watcher_links").get("findings_total")).toEqual({ notnull: 1, dflt_value: "0" });
      expect(rows(migrated, "SELECT findings_total FROM watcher_links")).toEqual([{ findings_total: 0 }]);
      expect(() => migrated.prepare("UPDATE watcher_links SET findings_total = -1").run()).toThrow(/CHECK constraint failed/u);
      expect(columns("watcher_links").has("command_attempts_this_turn")).toBe(false);
      expect(columns("watcher_wakes").has("finding_message_id")).toBe(false);
      expect(columns("watcher_wakes").get("digest_bytes")).toEqual({ notnull: 1, dflt_value: "0" });
    } finally {
      migrated.close();
    }
  });

  it("projects stored attribution through the message and queue codecs and drops malformed values", async () => {
    const before = await schema98Database();
    new RuntimeStore(before.databasePath, before.workspacePath, { recoverInterruptedRuns: false }).close();
    const seeded = new Database(before.databasePath);
    seeded.prepare("UPDATE messages SET watcher_note_json = ? WHERE id = ?").run(JSON.stringify(note), userMessageId);
    seeded.prepare("UPDATE messages SET watcher_note_json = ? WHERE id = 'message-user-2-006'")
      .run(JSON.stringify({ ...note, preset: "auditor" }));
    seeded.prepare("UPDATE queued_messages SET watcher_note_json = ?").run(JSON.stringify(note));
    seeded.close();
    const store = new RuntimeStore(before.databasePath, before.workspacePath, { recoverInterruptedRuns: false });
    try {
      const seededMessage = store.conversationDetail(conversationId)?.messages.find(({ id }) => id === userMessageId);
      expect(seededMessage?.watcherNote).toEqual(note);
      const fixtureMessages = store.conversationDetail("fixture-conversation-006")?.messages ?? [];
      expect(fixtureMessages.find(({ id }) => id === "message-user-2-006")).not.toHaveProperty("watcherNote");
      expect(store.queuedMessages.list("fixture-conversation-006")).toMatchObject([{ content: "Queued at schema 98", watcherNote: note }]);
      expect(store.conversationDetail(conversationId)).not.toHaveProperty("watcherWakes");
      expect(store.shellSnapshot().watchers).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("detaches a link when the watched chat is deleted in an upgraded database", async () => {
    const before = await schema98Database();
    const store = new RuntimeStore(before.databasePath, before.workspacePath, { recoverInterruptedRuns: false });
    try {
      const project = store.createProject("Upgraded project", before.workspacePath);
      const watched = store.createConversation(project.id, "Main chat");
      const { link, conversation } = store.watcherLinks.createWithConversation({
        link: {
          id: note.linkId, watchedConversationId: watched.id, preset: "reviewer", instructions: "",
          sharing: { ...DEFAULT_WATCHER_SHARING }, budgets: { ...DEFAULT_WATCHER_BUDGETS }, privateConnect: "inherit",
        },
        conversation: { projectId: project.id, title: "Watcher · Reviewer · Main chat", options: { interactionMode: "plan", accessMode: "supervised" } },
      }, "2026-10-02T00:00:00.000Z");
      expect(store.shellSnapshot().watchers).toMatchObject([{ id: link.id, watcherConversationId: conversation.id }]);
      store.deleteConversation(watched.id);
      expect(store.watcherLinks.get(link.id)).toMatchObject({
        status: "detached", detachedReason: "watched-deleted", watchedConversationId: null,
      });
      expect(store.shellSnapshot().watchers).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("upgrades a published database through schema 100 to schema 101 and keeps an existing link read-only", async () => {
    const before = await schema98Database();
    const projectId = "77777777-0000-4000-8000-000000000001";
    const watchedId = "77777777-0000-4000-8000-000000000002";
    const watcherId = "77777777-0000-4000-8000-000000000003";
    const at = "2026-10-03T00:00:00.000Z";
    const seeded = new Database(before.databasePath);
    try {
      migrateRuntimeDatabase(seeded, 100);
      seeded.pragma("foreign_keys = ON");
      cloneRow(seeded, "projects", "fixture-project-006", {
        id: projectId, path: before.workspacePath, normalized_path: before.workspacePath.toLowerCase(),
      });
      cloneRow(seeded, "conversations", "fixture-conversation-006", { id: watchedId, project_id: projectId, title: "Main chat" });
      cloneRow(seeded, "conversations", "fixture-conversation-006", {
        id: watcherId, project_id: projectId, title: "Watcher · Reviewer · Main chat", interaction_mode: "plan", access_mode: "supervised",
      });
      seeded.prepare(`
        INSERT INTO watcher_links (
          id, watcher_conversation_id, watched_conversation_id, project_id, preset, sharing_json, budgets_json,
          status, wake_allowance, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'reviewer', ?, ?, 'watching', 30, ?, ?)
      `).run(note.linkId, watcherId, watchedId, projectId, JSON.stringify(DEFAULT_WATCHER_SHARING), JSON.stringify(DEFAULT_WATCHER_BUDGETS), at, at);
      expect((seeded.pragma("table_info(watcher_links)") as { name: string }[]).some(({ name }) => name === "read_only")).toBe(false);
      expect((seeded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version).toBe(100);
    } finally {
      seeded.close();
    }
    const store = new RuntimeStore(before.databasePath, before.workspacePath, { recoverInterruptedRuns: false });
    try {
      expect(store.watcherLinks.get(note.linkId)).toMatchObject({ readOnly: true, status: "watching" });
      expect(store.watcherLinks.policyForConversation(watcherId)).toEqual({ linkId: note.linkId, status: "watching", readOnly: true });
    } finally {
      store.close();
    }
    const migrated = new Database(before.databasePath);
    try {
      expect((migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(101);
      const column = (migrated.pragma("table_info(watcher_links)") as { name: string; type: string; notnull: number; dflt_value: string | null }[])
        .find(({ name }) => name === "read_only");
      expect(column).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "1" });
      expect(migrated.prepare("SELECT read_only FROM watcher_links WHERE id = ?").get(note.linkId)).toEqual({ read_only: 1 });
      const setAccess = migrated.prepare("UPDATE watcher_links SET read_only = ? WHERE id = ?");
      expect(() => setAccess.run(0, note.linkId)).not.toThrow();
      expect(() => setAccess.run(2, note.linkId)).toThrow(/CHECK constraint failed/u);
      expect(() => setAccess.run(null, note.linkId)).toThrow(/NOT NULL constraint failed/u);
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
      expect(migrated.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      migrated.close();
    }
  });
});
