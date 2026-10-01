import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { RuntimeStore } from "../../src/server/database";
import { createConversationNotesCommandHandler } from "../../src/server/runtime/commands/conversation-notes-commands";
import { clientCommandSchema } from "../../src/shared/contracts";

import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function fixture(legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), "inertia-notes-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "inertia.sqlite");
  if (legacy) await copyFile("tests/fixtures/database/v0.0.1.sqlite", path);
  const store = new RuntimeStore(path, directory);
  cleanups.push(() => store.close());
  const project = store.createProject("Notes", directory);
  const chat = store.createConversation(project.id, "Task");
  return { store, chat, directory, path, project };
}

describe("conversation notes", () => {
  it.each([false, true])("persists notes across restart after a fresh or legacy migration (%s)", async (legacy) => {
    const { store, chat, path, directory } = await fixture(legacy);
    expect(store.conversationNotes.get(chat.id)).toMatchObject({ content: "", revision: 0, updatedAt: null });
    const before = store.shellSnapshot().conversations;
    store.conversationNotes.update(chat.id, "Decision: preserve cancellation.\nNext: test retries.", 0);
    expect(store.shellSnapshot().conversations).toEqual(before);
    expect(JSON.stringify(store.shellSnapshot())).not.toContain("Decision: preserve cancellation");
    const reopened = new RuntimeStore(path, directory);
    try { expect(reopened.conversationNotes.get(chat.id)).toMatchObject({ content: "Decision: preserve cancellation.\nNext: test retries.", revision: 1 }); }
    finally { reopened.close(); }
  });

  it("prevents stale overwrites, accepts acknowledged retries, and versions clearing a note", async () => {
    const { store, chat } = await fixture();
    const notes = store.conversationNotes;
    expect(notes.update(chat.id, "First window", 0).outcome).toBe("saved");
    expect(notes.update(chat.id, "Second window", 0)).toMatchObject({ outcome: "conflict", note: { content: "First window", revision: 1 } });
    expect(notes.update(chat.id, "First window", 0).note.revision).toBe(1);
    expect(notes.update(chat.id, "Second window", 1).note.revision).toBe(2);
    expect(notes.update(chat.id, "", 2).note).toMatchObject({ content: "", revision: 3 });
    expect(notes.update(chat.id, "stale draft", 0).outcome).toBe("conflict");
  });

  it("keeps notes separate per chat, bounds writes, and removes them with the chat", async () => {
    const { store, chat, project } = await fixture();
    const second = store.createConversation(project.id, "Another task");
    store.conversationNotes.update(chat.id, "Private notes", 0);
    expect(store.conversationNotes.get(second.id).content).toBe("");
    expect(() => store.conversationNotes.update(chat.id, "x".repeat(20_001), 1)).toThrow();
    expect(() => store.conversationNotes.update(chat.id, "a\0b", 1)).toThrow();
    expect(() => store.conversationNotes.update(chat.id, "invalid", -1)).toThrow();
    expect(() => store.conversationNotes.update(randomUUID(), "missing", 0)).toThrow();
    store.deleteConversation(chat.id);
    expect(() => store.conversationNotes.get(chat.id)).toThrow();
    expect(store.conversationNotes.get(second.id).revision).toBe(0);
  });

  it("routes validated reads and writes back to the requesting socket", async () => {
    const { store, chat } = await fixture();
    const send = vi.fn();
    const handler = createConversationNotesCommandHandler({ store, send });
    const socket = {} as WebSocket;
    for (const type of ["conversation.notes.update", "conversation.notes.get"] as const) {
      const command = clientCommandSchema.parse({ type, requestId: randomUUID(), payload: { conversationId: chat.id, ...(type.endsWith("update") ? { content: "Keep this", expectedRevision: 0 } : {}) } });
      await handler(socket, command);
      const [target, response] = send.mock.calls.at(-1)!;
      expect(target).toBe(socket);
      expect(serverEventSchema.parse(response)).toEqual(response);
      expect(response).toMatchObject({ requestId: command.requestId, result: { note: { content: "Keep this", revision: 1 } } });
    }
    expect(clientCommandSchema.safeParse({ type: "conversation.notes.update", requestId: randomUUID(), payload: { conversationId: chat.id, content: "x", expectedRevision: 0.5 } }).success).toBe(false);
  });
});
