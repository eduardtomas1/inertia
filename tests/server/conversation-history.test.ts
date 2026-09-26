import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { ConversationHistoryRepository, HISTORY_CONTENT_BYTES, HISTORY_PAGE_RECORDS, HISTORY_PREVIEW_BYTES } from "../../src/server/persistence/conversation-history-repository";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-bounded-history-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(path, directory);
  cleanups.push(() => store.close());
  const database = new Database(path);
  cleanups.push(() => database.close());
  const project = store.createProject("History", directory);
  const conversation = store.createConversation(project.id, "History");
  const repository = new ConversationHistoryRepository(database);
  return { store, database, conversation, repository, project };
}
function validDetail(detail: ReturnType<ConversationHistoryRepository["load"]>) {
  expect(detail).not.toBeNull();
  expect(() => parseServerEvent({ type: "request.result", requestId: randomUUID(), result: {
    kind: "conversation.detail", conversationId: detail!.conversation.id, state: "ready", detail,
  } })).not.toThrow();
}

describe("bounded durable conversation history", () => {
  it("opens a 75 MiB history in bounded pages without losing older messages", () => {
    const { database, conversation, store } = fixture();
    const insert = database.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, 'assistant', ?, '[]', ?)");
    const ids: string[] = [];
    database.transaction(() => {
      for (let index = 0; index < 75; index++) {
        const id = randomUUID(); ids.push(id);
        insert.run(id, conversation.id, "x".repeat(1024 * 1024), new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString());
      }
    })();
    const seen = new Set<string>();
    let detail = store.conversationHistory(conversation.id)!;
    let pages = 0;
    for (;;) {
      validDetail(detail);
      expect(detail.messages.length).toBeLessThanOrEqual(HISTORY_PAGE_RECORDS);
      expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(1024 * 1024);
      expect(detail.deferredContent).toHaveLength(detail.messages.length);
      for (const message of detail.messages) {
        expect(seen.has(message.id)).toBe(false); seen.add(message.id);
        expect(Buffer.byteLength(message.content)).toBeLessThanOrEqual(HISTORY_PREVIEW_BYTES);
      }
      pages++;
      if (!detail.history!.olderCursor) break;
      detail = store.conversationHistory(conversation.id, { cursor: detail.history!.olderCursor! })!;
    }
    expect(pages).toBe(4);
    expect(seen).toEqual(new Set(ids));
  });

  it("returns every UTF-8 byte across base text and chunks, including NUL and BOM", () => {
    const { store, conversation, repository } = fixture();
    const base = "\ufeff" + "a".repeat(HISTORY_CONTENT_BYTES - 3) + "🧭\0";
    const suffix = "\ufeff雪🧭\0".repeat(15_000);
    const message = store.createMessage(conversation.id, base, "assistant");
    store.appendMessageContent(message.id, suffix);
    const detail = repository.load(conversation.id)!;
    validDetail(detail);
    let cursor: string | null = detail.deferredContent![0]!.cursor;
    let content = "";
    while (cursor) {
      const result = repository.readContent(conversation.id, cursor);
      expect(result.offsetBytes).toBe(Buffer.byteLength(content));
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(HISTORY_CONTENT_BYTES);
      expect(() => parseServerEvent({ type: "request.result", requestId: randomUUID(), result })).not.toThrow();
      content += result.text; cursor = result.nextCursor;
    }
    expect(content).toBe(base + suffix);
  });

  it("keeps required turn/user/final/checkpoint references coherent across partial activity pages", () => {
    const { store, conversation, repository } = fixture();
    const { turn, message } = store.beginAgentTurn({ id: randomUUID(), conversationId: conversation.id, runId: randomUUID(), content: "Start", providerId: "codex", harnessId: "codex-app-server", backendProfileId: "codex", model: "gpt-test", reasoningEffort: "high", interactionMode: "build", accessMode: "supervised", configurationRevision: 0, association: "authoritative" });
    for (let index = 0; index < 50; index++) store.addActivity({ conversationId: conversation.id, turnId: turn.id, runId: turn.runId, kind: "tool", title: `Step ${index}`, detail: "Details", status: "completed" });
    const answer = store.createMessage(conversation.id, "Finished", "assistant", [], turn.id);
    const checkpoint = store.addCheckpoint({ conversationId: conversation.id, turnId: turn.id, ref: "head", label: "Checkpoint", turnIndex: 1, filesChanged: 0, insertions: 0, deletions: 0 });
    store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalAssistantMessageId: answer.id, checkpointId: checkpoint.id });
    let detail = repository.load(conversation.id)!;
    const seen = new Set<string>();
    for (;;) {
      validDetail(detail);
      expect(detail.agentTurns.map((entry) => entry.id)).toContain(turn.id);
      expect(detail.messages.map((entry) => entry.id)).toEqual(expect.arrayContaining([message.id, answer.id]));
      expect(detail.checkpoints.map((entry) => entry.id)).toContain(checkpoint.id);
      detail.activities.forEach((entry) => seen.add(entry.id));
      if (!detail.history!.olderCursor) break;
      detail = repository.load(conversation.id, { cursor: detail.history!.olderCursor! })!;
    }
    expect(seen.size).toBe(50);
  });

  it("retains subagent controls and ancestry after newer activity fills the page", () => {
    const { store, conversation, repository } = fixture();
    const { turn } = store.beginAgentTurn({ id: randomUUID(), conversationId: conversation.id, runId: randomUUID(), content: "Delegate", providerId: "claude", harnessId: "claude-agent-sdk", backendProfileId: "claude", model: "test", reasoningEffort: "", interactionMode: "build", accessMode: "supervised", configurationRevision: 0, association: "authoritative", requestedAt: "2026-01-01T00:00:00.000Z" });
    const input = { conversationId: conversation.id, runId: turn.runId, turnId: turn.id, providerId: "claude" as const,
      parentProviderAgentId: null, parentProviderToolUseId: null, providerToolUseId: null, providerRole: null,
      providerName: null, status: "running" as const, isLive: true, description: "Working", progress: null, result: null,
      sequence: 1, updatedAt: "2026-01-01T00:00:01.000Z" };
    const parent = store.upsertSubagentTrace({ ...input, providerAgentId: "parent-agent", providerTaskId: "parent-task" })!.trace;
    const child = store.upsertSubagentTrace({ ...input, providerAgentId: "child-agent", providerTaskId: "child-task", parentProviderAgentId: "parent-agent" })!.trace;
    for (let index = 0; index < 40; index++) store.addActivity({ conversationId: conversation.id, turnId: turn.id, runId: turn.runId,
      kind: "tool", title: `New activity ${index}`, detail: null, status: "completed", createdAt: "2026-01-01T00:01:00.000Z" });
    const detail = repository.load(conversation.id)!;
    validDetail(detail);
    expect(detail.history!.recordCount).toBe(HISTORY_PAGE_RECORDS);
    expect(detail.activities).toHaveLength(HISTORY_PAGE_RECORDS);
    expect(detail.subagents.map(({ id }) => id)).toEqual(expect.arrayContaining([parent.id, child.id]));
    expect(detail.subagents.find(({ id }) => id === child.id)?.parentTraceId).toBe(parent.id);
    expect(detail.agentTurns.map(({ id }) => id)).toContain(turn.id);
  });

  it("binds cursors to chat and runtime and rejects stale same-length text replacements", () => {
    const { store, database, conversation, repository, project } = fixture();
    const message = store.createMessage(conversation.id, "a".repeat(40_000));
    const second = store.createConversation(project.id, "Other");
    const cursor = repository.load(conversation.id)!.deferredContent![0]!.cursor;
    expect(() => repository.readContent(second.id, cursor)).toThrow(/another chat/);
    expect(() => new ConversationHistoryRepository(database).readContent(conversation.id, cursor)).toThrow(/expired/);
    expect(() => repository.readContent(conversation.id, cursor + "bad")).toThrow(/expired/);
    store.updateMessageContent(message.id, "b".repeat(40_000));
    expect(() => repository.readContent(conversation.id, cursor)).toThrow(/changed/);
    const next = repository.load(conversation.id)!.deferredContent![0]!.cursor;
    store.appendMessageContent(message.id, "next");
    expect(() => repository.readContent(conversation.id, next)).toThrow(/changed/);
  });

  it("anchors old search results and keeps navigation stable when backdated records arrive", () => {
    const { store, conversation, repository } = fixture();
    const messages = Array.from({ length: 55 }, (_, index) => store.createMessage(conversation.id, `${index}`, "user", [], null, "2026-01-01T00:00:00.000Z"));
    const latest = repository.load(conversation.id)!;
    const ids = new Set(latest.messages.map((entry) => entry.id));
    const anchor = messages.find((entry) => !ids.has(entry.id))!;
    const anchored = repository.load(conversation.id, { anchorMessageId: anchor.id })!;
    expect(anchored.messages.map((entry) => entry.id)).toContain(anchor.id);
    expect(anchored.history!.newerCursor).toBeTruthy();
    const added = store.createMessage(conversation.id, "New backdated record", "user", [], null, "2025-01-01T00:00:00.000Z");
    let page = latest;
    for (;;) {
      expect(page.messages.map((entry) => entry.id)).not.toContain(added.id);
      if (!page.history!.olderCursor) break;
      page = repository.load(conversation.id, { cursor: page.history!.olderCursor! })!;
    }
  });

  it("rejects oversized legacy metadata before projecting full rows", () => {
    const { store, database, conversation, repository } = fixture();
    const message = store.createMessage(conversation.id, "Small content");
    database.prepare("UPDATE messages SET attachments_json = ? WHERE id = ?").run(" ".repeat(2 * 1024 * 1024) + "[]", message.id);
    expect(() => repository.load(conversation.id)).toThrow(/oversized metadata/);
    expect(database.prepare("SELECT length(attachments_json) AS bytes FROM messages WHERE id = ?").get(message.id)).toEqual({ bytes: 2 * 1024 * 1024 + 2 });
  });

  it("pages legacy plans without turn IDs and deduplicates plans attached to turns", () => {
    const { store, conversation, repository } = fixture();
    for (let index = 0; index < 55; index++) store.upsertAgentPlan({ conversationId: conversation.id, runId: `legacy-run-${index}`, turnId: null, explanation: `Plan ${index}`, steps: [{ step: "Keep the existing plan", status: "pending" }] });
    const { turn } = store.beginAgentTurn({ id: randomUUID(), conversationId: conversation.id, runId: randomUUID(), content: "Current request", providerId: "codex", harnessId: "codex-app-server", backendProfileId: "codex", model: "gpt-test", reasoningEffort: "high", interactionMode: "build", accessMode: "supervised", configurationRevision: 0, association: "authoritative" });
    store.upsertAgentPlan({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id, explanation: "Current plan", steps: [{ step: "Continue", status: "inProgress" }] });
    const seen = new Set<string>();
    let detail = repository.load(conversation.id)!;
    for (;;) {
      validDetail(detail);
      expect(detail.plans.length).toBeLessThanOrEqual(HISTORY_PAGE_RECORDS);
      expect(new Set(detail.plans.map((plan) => plan.runId)).size).toBe(detail.plans.length);
      detail.plans.forEach((plan) => seen.add(plan.runId));
      if (!detail.history!.olderCursor) break;
      detail = repository.load(conversation.id, { cursor: detail.history!.olderCursor! })!;
    }
    expect(seen.size).toBe(56);
  });

  it("retains review summaries, state and editable notes on every history page", () => {
    const { store, conversation, repository } = fixture();
    for (let index = 0; index < 50; index++) store.createMessage(conversation.id, `Message ${index}`);
    const summary = store.upsertReviewSummary({ conversationId: conversation.id, fingerprint: "a".repeat(64), providerId: "codex", harnessId: "codex-app-server", backendProfileId: "legacy:codex:codex-app-server", model: "gpt-test", overall: "Review remains available.", classifications: [], files: [], generatedAt: new Date().toISOString() });
    const state = store.setReviewState({ conversationId: conversation.id, repositoryPath: ".", scope: "file", path: "src/app.ts", hunkId: null, targetFingerprint: "b".repeat(64), reviewed: true });
    const note = store.createReviewNote({ conversationId: conversation.id, repositoryPath: ".", path: "src/app.ts", hunkId: null, lineIds: [], targetFingerprint: "b".repeat(64), body: "Check this path." });
    const latest = repository.load(conversation.id)!;
    const older = repository.load(conversation.id, { cursor: latest.history!.olderCursor! })!;
    for (const page of [latest, older]) {
      validDetail(page);
      expect(page.reviewSummaries).toEqual([summary]);
      expect(page.reviewStates).toEqual([state]);
      expect(page.reviewNotes).toEqual([note]);
    }
    store.updateReviewNote(conversation.id, note.id, "Edited after reload.");
    expect(repository.load(conversation.id)!.reviewNotes[0]?.body).toBe("Edited after reload.");
    store.deleteReviewNote(conversation.id, note.id);
    expect(repository.load(conversation.id)!.reviewNotes).toEqual([]);
  });

  it("fails visibly before loading an oversized review collection instead of dropping notes", () => {
    const { store, database, conversation, repository } = fixture();
    const note = store.createReviewNote({ conversationId: conversation.id, path: "src/app.ts", hunkId: null, lineIds: [], targetFingerprint: "b".repeat(64), body: "Keep" });
    const insert = database.prepare(`INSERT INTO diff_review_notes (id, conversation_id, repository_path, path, hunk_id, line_ids_json, target_fingerprint, body, stale, created_at, updated_at)
      SELECT ?, conversation_id, repository_path, path, hunk_id, line_ids_json, target_fingerprint, ?, stale, created_at, updated_at FROM diff_review_notes WHERE id = ?`);
    database.transaction(() => { for (let index = 0; index < 600; index++) insert.run(randomUUID(), "x".repeat(8000), note.id); })();
    expect(() => repository.load(conversation.id)).toThrow(/oversized metadata/);
    expect(database.prepare("SELECT COUNT(*) AS count FROM diff_review_notes WHERE conversation_id = ?").get(conversation.id)).toEqual({ count: 601 });
  });
});
