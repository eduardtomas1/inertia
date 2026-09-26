import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { AttachmentGalleryRepository } from "../../src/server/persistence/attachment-gallery-repository";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import { clientCommandSchema, type AppSnapshot } from "../../src/shared/contracts";
import { runtimeSafetyAllowsCommand } from "../../src/server/runtime/commands/runtime-safety";
import { detachedChatCommandRejection, type DetachedChatRuntimePolicyResources } from "../../src/server/runtime/detached-chat-runtime-policy";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-attachment-gallery-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(path, directory); cleanups.push(() => store.close());
  const queries: string[] = [];
  const database = new Database(path, { verbose: (sql) => queries.push(String(sql)) }); cleanups.push(() => database.close());
  const project = store.createProject("Gallery", directory);
  const conversation = store.createConversation(project.id, "Gallery");
  const gallery = new AttachmentGalleryRepository(database);
  const insert = database.prepare("INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const image = (index: number, id = randomUUID()) => ({ id, name: `gallery-${index}.png`, mimeType: "image/png", size: 1024, path: "/private/never-publish", snapshot: { context: "private accessibility text" } });
  const add = (index: number, attachment = image(index), role = "user") => {
    insert.run(randomUUID(), conversation.id, role, "Transcript content must not be fetched by the gallery.".repeat(1000), JSON.stringify([attachment]), new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString());
    return attachment;
  };
  return { store, database, gallery, conversation, project, image, add, queries };
}

describe("independent bounded attachment gallery", () => {
  it("finds all sixty images even when the transcript hydration contains only its last page", () => {
    const { store, gallery, conversation, add, queries } = fixture();
    for (let index = 0; index < 60; index += 1) add(index);
    expect(store.conversationHistory(conversation.id)!.messages.length).toBeLessThan(60);
    queries.length = 0;
    const result = gallery.list(conversation.id);
    expect(result.attachments).toHaveLength(60);
    expect(result.attachments[0]?.name).toBe("gallery-59.png");
    expect(result.attachments.at(-1)?.name).toBe("gallery-0.png");
    expect(result.olderCursor).toBeNull(); expect(result.newerCursor).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/private|accessibility|Transcript content/u);
    expect(queries.join("\n")).not.toMatch(/\bcontent\b/u);
    expect(() => parseServerEvent({ type: "request.result", requestId: randomUUID(), result })).not.toThrow();
  });

  it("replaces pages in both directions, deduplicates IDs, and freezes pagination against new images", () => {
    const { gallery, conversation, image, add } = fixture();
    const first = image(0); add(0, first);
    for (let index = 1; index < 135; index += 1) add(index);
    add(136, first); // A reused image appears once, at its newest occurrence.
    add(137, image(137), "assistant");
    const newest = gallery.list(conversation.id);
    expect(newest.attachments).toHaveLength(60);
    add(138); // Subsequent pages keep the original watermark.
    const middle = gallery.list(conversation.id, newest.olderCursor!);
    const oldest = gallery.list(conversation.id, middle.olderCursor!);
    expect(middle.attachments).toHaveLength(60); expect(oldest.attachments).toHaveLength(15);
    expect(oldest.olderCursor).toBeNull();
    expect(gallery.list(conversation.id, middle.newerCursor!).attachments).toEqual(newest.attachments);
    expect(gallery.list(conversation.id, oldest.newerCursor!).attachments).toEqual(middle.attachments);
    const all = [...newest.attachments, ...middle.attachments, ...oldest.attachments];
    expect(new Set(all.map(({ id }) => id)).size).toBe(135);
    expect(all.some(({ name }) => name === "gallery-138.png")).toBe(false);
    expect(gallery.list(conversation.id).attachments[0]?.name).toBe("gallery-138.png");
  });

  it("rejects foreign, modified, and prior-runtime cursors and bounds projected metadata in SQL", () => {
    const { store, database, gallery, conversation, project, add, image } = fixture();
    for (let index = 0; index < 61; index += 1) add(index);
    const result = gallery.list(conversation.id);
    const other = store.createConversation(project.id, "Other");
    expect(() => gallery.list(other.id, result.olderCursor!)).toThrow("another chat");
    expect(() => gallery.list(conversation.id, `${result.olderCursor!}broken`)).toThrow("expired");
    expect(() => new AttachmentGalleryRepository(database).list(conversation.id, result.olderCursor!)).toThrow("expired");
    const huge = { ...image(100), name: "x".repeat(1024 * 1024) }; add(100, huge);
    const bounded = gallery.list(conversation.id);
    expect(bounded.attachments[0]?.name).toHaveLength(512);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(30_000);
  });

  it("keeps gallery reads available in recovery and scoped to the exact detached chat", () => {
    const conversationId = randomUUID();
    const command = clientCommandSchema.parse({ type: "conversation.attachments.list", requestId: randomUUID(), payload: { conversationId } });
    expect(runtimeSafetyAllowsCommand(command.type)).toBe(true);
    const resources = { snapshot: () => ({ conversations: [] }) as unknown as AppSnapshot } as DetachedChatRuntimePolicyResources;
    expect(detachedChatCommandRejection({ kind: "detached-chat", conversationId, clientId: randomUUID() }, command, resources)).toBeNull();
    expect(detachedChatCommandRejection({ kind: "detached-chat", conversationId: randomUUID(), clientId: randomUUID() }, command, resources)).not.toBeNull();
    expect(clientCommandSchema.safeParse({ ...command, payload: { conversationId, cursor: "x".repeat(4097) } }).success).toBe(false);
  });
});
