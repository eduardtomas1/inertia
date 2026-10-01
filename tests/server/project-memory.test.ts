// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { clientCommandSchema } from "../../src/shared/contracts";
import { projectMemoryContext, projectMemoryStateSchema, type ProjectMemoryDraft } from "../../src/shared/project-memory";
import { assembleTurnRequest } from "../../src/server/runtime/turns/request-context";

const roots: string[] = [];
const stores: RuntimeStore[] = [];
const draft: ProjectMemoryDraft = { kind: "decision", title: "Preserve billing history", text: "Use the saved proration context.", reason: "Direct event queries miss previous-cycle plan changes." };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inertia-project-memory-")); roots.push(root);
  const path = join(root, "inertia.sqlite");
  const store = new RuntimeStore(path, root); stores.push(store);
  const project = store.createProject("Billing", root);
  const chat = store.createConversation(project.id, "Billing investigation");
  return { store, project, chat, root, path };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project rules and decisions", () => {
  it("keeps edited decisions and immutable provenance after restart and source deletion", () => {
    const { store, project, chat, root, path } = fixture();
    const message = store.createMessage(chat.id, "We rejected a direct event query.", "assistant");
    const id = randomUUID();
    const source = { conversationId: chat.id, messageId: message.id };
    const first = store.projectMemory.save({ projectId: project.id, id, mode: "create", expectedRevision: 0, entry: draft, source });
    store.appendMessageContent(message.id, " Streamed explanation.");
    expect(store.projectMemory.sourcePreview({ projectId: project.id, id })).toMatchObject({
      content: "We rejected a direct event query. Streamed explanation.", truncated: false,
    });
    store.appendMessageContent(message.id, "x".repeat(5000));
    const preview = store.projectMemory.sourcePreview({ projectId: project.id, id });
    expect(preview.content).toHaveLength(4000);
    expect(preview.truncated).toBe(true);
    expect(projectMemoryStateSchema.parse(first).entries[0]).toMatchObject({ ...draft, source: { ...source, conversationTitle: chat.title } });
    store.projectMemory.save({ projectId: project.id, id, mode: "update", expectedRevision: 1, entry: { ...draft, reason: "The previous-cycle regression test protects this decision." } });
    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new RuntimeStore(path, root); stores.push(reopened);
    expect(reopened.projectMemory.load({ projectId: project.id })).toMatchObject({ revision: 2, entries: [{ id, source }], unavailableSourceIds: [] });
    reopened.deleteConversation(chat.id);
    const retained = reopened.projectMemory.load({ projectId: project.id });
    expect(retained.entries[0].source).toMatchObject(source);
    expect(retained.unavailableSourceIds).toEqual([id]);
    expect(retained.context).toContain("previous-cycle regression test");
  });

  it("isolates projects, validates source ownership, and rejects conflicting edits without changing state", () => {
    const { store, project, chat, root } = fixture();
    mkdirSync(join(root, "other"));
    const other = store.createProject("Other", join(root, "other"));
    const otherChat = store.createConversation(other.id, "Other chat");
    const foreign = store.createMessage(otherChat.id, "Foreign message", "user");
    const id = randomUUID();
    expect(() => store.projectMemory.load({ projectId: project.id, conversationId: otherChat.id })).toThrow("does not belong");
    expect(() => store.projectMemory.save({ projectId: project.id, id, mode: "create", expectedRevision: 0, entry: draft,
      source: { conversationId: chat.id, messageId: foreign.id } })).toThrow("source message");
    store.projectMemory.save({ projectId: project.id, id, mode: "create", expectedRevision: 0, entry: draft });
    const before = store.projectMemory.load({ projectId: project.id });
    expect(() => store.projectMemory.save({ projectId: project.id, id, mode: "update", expectedRevision: 0, entry: { ...draft, text: "Stale writer" } })).toThrow("another window");
    expect(store.projectMemory.load({ projectId: project.id })).toEqual(before);
    expect(store.projectMemory.contextForConversation(otherChat.id)).toBeNull();
    store.projectMemory.remove({ projectId: project.id, id, expectedRevision: 1 });
    expect(() => store.projectMemory.save({ projectId: project.id, id, mode: "update", expectedRevision: 2, entry: draft })).toThrow("deleted");
  });

  it("persists chat exclusions without affecting other providers or reviving deleted entries", () => {
    const { store, project, chat, path, root } = fixture();
    const second = store.createConversation(project.id, "Claude chat", { providerId: "claude" });
    const id = randomUUID();
    store.projectMemory.save({ projectId: project.id, id, mode: "create", expectedRevision: 0, entry: draft });
    const excluded = store.projectMemory.toggle({ projectId: project.id, conversationId: chat.id, id, expectedRevision: 1, expectedChatRevision: 0, enabled: false });
    expect(excluded.context).not.toContain(draft.reason);
    expect(JSON.parse(excluded.context!).entries).toEqual([]);
    expect(store.projectMemory.contextForConversation(second.id)).toContain(draft.reason);
    expect(() => store.projectMemory.toggle({ projectId: project.id, conversationId: chat.id, id, expectedRevision: 1, expectedChatRevision: 0, enabled: true })).toThrow("another window");
    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new RuntimeStore(path, root); stores.push(reopened);
    expect(reopened.projectMemory.load({ projectId: project.id, conversationId: chat.id }).disabledIds).toEqual([id]);
    reopened.projectMemory.remove({ projectId: project.id, id, expectedRevision: 1 });
    expect(reopened.projectMemory.load({ projectId: project.id, conversationId: chat.id }).disabledIds).toEqual([]);
    expect(reopened.projectMemory.contextForConversation(second.id)).toContain('"entries": []');
  });

  it("bounds entries and encoded bytes transactionally", () => {
    const { store, project } = fixture();
    for (let i = 0; i < 20; i++) store.projectMemory.save({ projectId: project.id, id: randomUUID(), mode: "create", expectedRevision: i, entry: draft });
    expect(() => store.projectMemory.save({ projectId: project.id, id: randomUUID(), mode: "create", expectedRevision: 20, entry: draft })).toThrow("full");
    const loaded = store.projectMemory.load({ projectId: project.id });
    store.projectMemory.save({ projectId: project.id, id: loaded.entries[0].id, mode: "update", expectedRevision: 20,
      entry: { ...draft, text: "a".repeat(1600), reason: "b".repeat(1200) } });
    const before = store.projectMemory.load({ projectId: project.id });
    expect(() => store.projectMemory.save({ projectId: project.id, id: before.entries[1].id, mode: "update", expectedRevision: 21,
      entry: { ...draft, title: "\u0001".repeat(120), text: "\u0001".repeat(1600), reason: "\u0001".repeat(1200) } })).toThrow("concise");
    expect(store.projectMemory.load({ projectId: project.id })).toEqual(before);
  });

  it("previews the exact bounded context and persists it without changing visible user prose", () => {
    const { store, project, chat, root } = fixture();
    const state = store.projectMemory.save({ projectId: project.id, conversationId: chat.id, id: randomUUID(), mode: "create", expectedRevision: 0, entry: draft });
    const assembled = assembleTurnRequest({ cwd: root, visibleContent: "Fix the invoice.", projectMemoryContext: store.projectMemory.contextForConversation(chat.id) });
    expect(() => assembleTurnRequest({ cwd: root, visibleContent: "Fix", documentContexts: [{
      attachmentId: randomUUID(), label: "Project rules & decisions", content: "Not project memory", truncated: false,
    }] })).toThrow("reserved project memory label");
    expect(assembled.visibleContent).toBe("Fix the invoice.");
    expect(assembled.persistence.blobs[0].content).toBe(state.context);
    expect(state.context).toBe(projectMemoryContext(state));
    expect(assembled.persistence.manifest.internalInstructionCount).toBe(0);
    expect(JSON.stringify(assembled.persistence.manifest)).not.toContain(draft.reason);
    expect(() => assembleTurnRequest({ cwd: root, visibleContent: "Fix", projectMemoryContext: "a".repeat(32769) })).toThrow("exceeds");
  });

  it("upgrades the released schema without changing chats and removes project memory with its owner", () => {
    const { store, path, project, chat, root } = fixture();
    store.close(); stores.splice(stores.indexOf(store), 1);
    const db = new Database(path);
    db.exec("DROP TABLE conversation_project_memory; DROP TABLE project_memory; DELETE FROM schema_migrations WHERE version = 86; PRAGMA user_version = 85;");
    migrateRuntimeDatabase(db);
    expect(db.prepare("SELECT title FROM conversations WHERE id = ?").get(chat.id)).toEqual({ title: chat.title });
    expect(db.prepare("SELECT count(*) AS count FROM project_memory").get()).toEqual({ count: 0 });
    db.close();
    const reopened = new RuntimeStore(path, root); stores.push(reopened);
    reopened.projectMemory.save({ projectId: project.id, id: randomUUID(), mode: "create", expectedRevision: 0, entry: draft });
    reopened.removeProject(project.id);
    expect(() => reopened.projectMemory.load({ projectId: project.id })).toThrow("no longer available");
  });

  it("rejects forged scope, provenance fields, and unbounded content at the IPC boundary", () => {
    const command = { type: "project.memory.save", requestId: randomUUID(), payload: {
      projectId: randomUUID(), id: randomUUID(), mode: "create", expectedRevision: 0, entry: draft,
    } };
    expect(clientCommandSchema.safeParse(command).success).toBe(true);
    expect(clientCommandSchema.safeParse({ ...command, payload: { ...command.payload, source: { conversationId: randomUUID(), messageId: randomUUID(), conversationTitle: "Forged" } } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ ...command, payload: { ...command.payload, entry: { ...draft, reason: "\0" } } }).success).toBe(false);
  });
});
