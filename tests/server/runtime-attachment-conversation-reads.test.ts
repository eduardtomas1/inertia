import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_RUNTIME_ATTACHMENT_CONVERSATIONS } from "../../src/node/runtime-attachment-protocol";
import { parseRuntimeWorkerCommand, parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import { RuntimeStore } from "../../src/server/database";
import { answerRuntimeAttachmentConversations } from "../../src/server/runtime-attachment-conversation-reads";

const REQUEST_ID = "0b5e3a52-1c55-4a0e-9d6f-1f8f3e7a2c10";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function query(attachmentId: string) {
  const parsed = parseRuntimeWorkerCommand({ type: "runtime.attachment-conversations", requestId: REQUEST_ID, attachmentId });
  if (parsed?.type !== "runtime.attachment-conversations") throw new Error("Expected an attachment owner query.");
  return parsed;
}

function attachment(id: string): Record<string, unknown> {
  return { id, name: "reference.png", path: id, mimeType: "image/png", size: 8 };
}

describe("runtime attachment owner reads", () => {
  it("names only the chats whose readable messages carry the attachment", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-attachment-owners-"));
    directories.push(directory);
    const databasePath = join(directory, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    try {
      const project = store.createProject("Owners", directory);
      const owner = store.createConversation(project.id, "Owner");
      const other = store.createConversation(project.id, "Other");
      const corrupt = store.createConversation(project.id, "Corrupt");
      const shared = randomUUID();
      store.createMessage(owner.id, "Look at this", "user", [attachment(shared)] as never);
      store.createMessage(other.id, "Something else", "user", [attachment(randomUUID())] as never);
      const raw = new Database(databasePath);
      try {
        raw.prepare(`
          INSERT INTO messages (id, conversation_id, turn_id, role, content, attachments_json, created_at)
          VALUES (?, ?, NULL, 'user', 'raw', ?, ?)
        `).run(randomUUID(), corrupt.id, `not-json ${shared}`, new Date().toISOString());
      } finally {
        raw.close();
      }

      // Cleanup stays conservative and keeps counting the unreadable chat.
      expect(store.attachmentConversationIds([shared]).sort()).toEqual([owner.id, corrupt.id].sort());
      const reader = {
        attachmentConversations: (id: string) => store.attachmentConversationIds([id], { includeUnreadable: false }),
      };
      const event = answerRuntimeAttachmentConversations(reader, query(shared));
      expect(event).toEqual({ type: "runtime.attachment-conversations-resolved", requestId: REQUEST_ID, conversationIds: [owner.id] });
      expect(parseRuntimeWorkerEvent(event)).toEqual(event);

      const unknown = answerRuntimeAttachmentConversations(reader, query(randomUUID()));
      expect(unknown).toEqual({ type: "runtime.attachment-conversations-resolved", requestId: REQUEST_ID, conversationIds: [] });
    } finally {
      store.close();
    }
  });

  it("rejects when the runtime is unavailable, the read fails, or the owners would not fit, without leaking detail", () => {
    const attachmentId = randomUUID();
    const unavailable = answerRuntimeAttachmentConversations(null, query(attachmentId));
    expect(unavailable).toEqual({
      type: "runtime.attachment-conversations-rejected", requestId: REQUEST_ID, message: "The local runtime is not ready.",
    });
    expect(parseRuntimeWorkerEvent(unavailable)).toEqual(unavailable);

    const failed = answerRuntimeAttachmentConversations({
      attachmentConversations: () => { throw new Error("SQLITE_CORRUPT at /secret/inertia.sqlite"); },
    }, query(attachmentId));
    expect(failed).toEqual({
      type: "runtime.attachment-conversations-rejected", requestId: REQUEST_ID, message: "The attachment's chats could not be read.",
    });
    expect(parseRuntimeWorkerEvent(failed)).toEqual(failed);

    const many = Array.from({ length: MAX_RUNTIME_ATTACHMENT_CONVERSATIONS + 1 }, () => randomUUID());
    expect(answerRuntimeAttachmentConversations({ attachmentConversations: () => many }, query(attachmentId)).type)
      .toBe("runtime.attachment-conversations-rejected");
  });

  it("only accepts well-formed queries and answers", () => {
    const attachmentId = randomUUID();
    expect(parseRuntimeWorkerCommand({ type: "runtime.attachment-conversations", requestId: REQUEST_ID, attachmentId: "../x" })).toBeNull();
    expect(parseRuntimeWorkerCommand({ type: "runtime.attachment-conversations", requestId: "x", attachmentId })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.attachment-conversations", requestId: REQUEST_ID, attachmentId, extra: true,
    })).toBeNull();
    expect(parseRuntimeWorkerEvent({
      type: "runtime.attachment-conversations-resolved", requestId: REQUEST_ID, conversationIds: ["not-a-chat"],
    })).toBeNull();
    expect(parseRuntimeWorkerEvent({
      type: "runtime.attachment-conversations-resolved",
      requestId: REQUEST_ID,
      conversationIds: Array.from({ length: MAX_RUNTIME_ATTACHMENT_CONVERSATIONS + 1 }, () => randomUUID()),
    })).toBeNull();
    expect(parseRuntimeWorkerEvent({
      type: "runtime.attachment-conversations-rejected", requestId: REQUEST_ID, message: " ",
    })).toBeNull();
  });
});
