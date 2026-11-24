import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { RuntimeStore } from "../../src/server/database";
import { createConversationReadCommandHandler } from "../../src/server/runtime/commands/conversation-read-commands";
import { ACTIVITY_DETAIL_PREVIEW_CHARS } from "../../src/server/persistence/activity-detail-preview";
import { archivedConversationsRequestSchema } from "../../src/shared/archived-conversations";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import type { ServerEvent } from "../../src/shared/contracts";

const fixtures: { directory: string; store: RuntimeStore }[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const { directory, store } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-targeted-queries-"));
  const store = new RuntimeStore(join(directory, "test.sqlite"), directory);
  fixtures.push({ directory, store });
  return { store, directory };
}

function at(second: number): Date {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, second));
}

function seeded() {
  const { store, directory } = fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(0));
  const first = store.createProject("First", directory);
  mkdirSync(join(directory, "second"));
  const second = store.createProject("Second", join(directory, "second"));
  const live = [0, 1, 2].map((index) => {
    vi.setSystemTime(at(index + 1));
    return store.createConversation(index === 2 ? second.id : first.id, `Live ${index}`);
  });
  const archived = [0, 1, 2, 3].map((index) => {
    vi.setSystemTime(at(index + 10));
    const conversation = store.createConversation(first.id, `Archived ${index}`);
    vi.setSystemTime(at(index + 20));
    store.archiveConversation(conversation.id, true);
    return conversation;
  });
  vi.useRealTimers();
  return { store, first, second, live, archived };
}

describe("targeted store reads", () => {
  it("return what the shell snapshot carried for projects, settings and conversations", () => {
    const { store, first, second, live, archived } = seeded();
    store.updateSettings({ theme: "dark" });
    const snapshot = store.shellSnapshot();

    expect(store.projects()).toEqual(snapshot.projects);
    expect(store.settings()).toEqual(snapshot.settings);
    expect(store.conversationIds()).toEqual([
      ...archived.map(({ id }) => id).reverse(),
      ...live.map(({ id }) => id).reverse(),
    ]);
    const firstConversations = store.projectConversations(first.id);
    expect(firstConversations.map(({ id }) => id).sort())
      .toEqual([live[0]!.id, live[1]!.id, ...archived.map(({ id }) => id)].sort());
    for (const conversation of firstConversations) {
      expect(conversation).toEqual(store.conversationShell(conversation.id));
      const shell = snapshot.conversations.find(({ id }) => id === conversation.id);
      if (conversation.archivedAt === null) expect(conversation).toEqual(shell);
      else expect(shell).toBeUndefined();
    }
    expect(store.projectConversations(second.id)).toEqual(
      snapshot.conversations.filter(({ projectId }) => projectId === second.id),
    );
    expect(store.projectConversations(randomUUID())).toEqual([]);
  });
});

describe("archived conversations in the live snapshot", () => {
  it("leaves unreferenced archived chats out and keeps the referenced ones resolvable", () => {
    const { store, first, live, archived } = seeded();
    store.todos.create({ id: randomUUID(), title: "Follow up", projectId: first.id });
    const todo = store.todos.list()[0]!;
    store.todos.link(todo.id, archived[0]!.id);
    store.createWorkspaceRun({
      kind: "check", projectId: first.id, conversationId: archived[1]!.id,
      label: "npm test", detail: null, status: "succeeded", port: null,
    });
    const snapshot = store.shellSnapshot();

    expect(snapshot.conversations.map(({ id }) => id).sort()).toEqual(live.map(({ id }) => id).sort());
    expect(snapshot.archivedConversationCount).toBe(4);
    expect(snapshot.archivedConversationRefs).toEqual([archived[1]!, archived[0]!].map((conversation) => ({
      id: conversation.id,
      projectId: conversation.projectId,
      title: conversation.title,
      providerId: conversation.providerId,
      archivedAt: store.conversation(conversation.id).archivedAt,
    })));
    const event: ServerEvent = { type: "snapshot.updated", snapshot };
    expect(parseServerEvent(event)).toEqual(event);
    const unresolved: ServerEvent = {
      type: "snapshot.updated",
      snapshot: { ...snapshot, archivedConversationRefs: [] },
    };
    expect(() => parseServerEvent(unresolved)).toThrow();
  });

  it("keeps the selected chat even while it is archived and brings a restored chat back", () => {
    const { store, archived } = seeded();
    store.selectConversation(archived[2]!.id);
    let snapshot = store.shellSnapshot();
    expect(snapshot.activeConversationId).toBe(archived[2]!.id);
    expect(snapshot.conversations.some(({ id }) => id === archived[2]!.id)).toBe(true);
    expect(snapshot.archivedConversationRefs?.some(({ id }) => id === archived[2]!.id)).toBe(false);
    const selected: ServerEvent = { type: "snapshot.updated", snapshot };
    expect(parseServerEvent(selected)).toEqual(selected);

    store.archiveConversation(archived[3]!.id, false);
    snapshot = store.shellSnapshot();
    expect(snapshot.conversations.find(({ id }) => id === archived[3]!.id)?.archivedAt).toBeNull();
    expect(snapshot.archivedConversationCount).toBe(3);
  });
});

describe("archived conversation pages", () => {
  it("pages newest first by archive time with a cursor and filters by title or provider", () => {
    const { store, first } = seededMany();
    const page = store.archivedConversations({ limit: 20 });
    expect(page.conversations).toHaveLength(20);
    expect(page.total).toBe(25);
    expect(page.conversations.every(({ archivedAt }) => archivedAt !== null)).toBe(true);
    const ordered = [...page.conversations].sort((left, right) =>
      right.archivedAt!.localeCompare(left.archivedAt!) || left.id.localeCompare(right.id));
    expect(page.conversations).toEqual(ordered);
    const next = store.archivedConversations({ after: page.next, limit: 20 });
    expect(next.conversations).toHaveLength(5);
    expect(next.next).toBeNull();
    expect(new Set([...page.conversations, ...next.conversations].map(({ id }) => id)).size).toBe(25);

    const odd = store.archivedConversations({ query: "ODD" });
    expect(odd.total).toBe(12);
    expect(odd.conversations.every(({ title }) => title.startsWith("Odd"))).toBe(true);
    expect(store.archivedConversations({ query: "claude-label", providerIds: ["codex"] }).total).toBe(25);
    expect(store.archivedConversations({ query: "missing" })).toEqual({
      kind: "conversation.archived", conversations: [], total: 0, next: null,
    });
    const unicodeChat = store.createConversation(first.id, "Überprüfung und École");
    store.archiveConversation(unicodeChat.id, true);
    expect(store.archivedConversations({ query: "über" }).conversations.map(({ id }) => id)).toEqual([unicodeChat.id]);
    expect(store.archivedConversations({ query: "Über" }).conversations.map(({ id }) => id)).toEqual([unicodeChat.id]);
    expect(store.archivedConversations({ query: "école" }).conversations.map(({ id }) => id)).toEqual([unicodeChat.id]);
    expect(first.id).toBeTruthy();
    const event: ServerEvent = { type: "request.result", requestId: "archived", result: page };
    expect(parseServerEvent(event)).toEqual(event);
  });

  it("validates the request at the boundary", () => {
    expect(archivedConversationsRequestSchema.safeParse({ limit: 21 }).success).toBe(false);
    expect(archivedConversationsRequestSchema.safeParse({ query: "x".repeat(201) }).success).toBe(false);
    expect(archivedConversationsRequestSchema.safeParse({ providerIds: ["unknown"] }).success).toBe(false);
    expect(archivedConversationsRequestSchema.safeParse({ after: { archivedAt: "x", id: "not-a-uuid" } }).success).toBe(false);
    expect(archivedConversationsRequestSchema.safeParse({ extra: true }).success).toBe(false);
    expect(archivedConversationsRequestSchema.safeParse({}).success).toBe(true);
  });
});

function seededMany() {
  const { store, directory } = fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(0));
  const first = store.createProject("Many", directory);
  for (let index = 0; index < 27; index += 1) {
    vi.setSystemTime(at(index + 1));
    const conversation = store.createConversation(first.id, `${index % 2 === 0 ? "Even" : "Odd"} ${index}`);
    if (index < 25) {
      vi.setSystemTime(at(100 + (index % 7)));
      store.archiveConversation(conversation.id, true);
    }
  }
  vi.useRealTimers();
  return { store, first };
}

describe("activity detail on demand", () => {
  function withActivities() {
    const { store, directory } = fixture();
    const project = store.createProject("Detail", directory);
    const conversation = store.createConversation(project.id, "Tools");
    const other = store.createConversation(project.id, "Other");
    const requestedAt = at(1).toISOString();
    const { turn } = store.beginAgentTurn({ id: "turn-1", runId: "run-1", conversationId: conversation.id,
      content: "Run it", providerId: "codex", harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server", model: "gpt-test", reasoningEffort: "high",
      interactionMode: "build", accessMode: "supervised", configurationRevision: 1,
      association: "authoritative", requestedAt });
    const output = `Command:\nnpm test\n\nOutput:\n${"line of output\n".repeat(600)}\nError:\nwarning: skipped 3 suites`;
    const command = store.addActivity({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id,
      kind: "command", title: "Run npm test", detail: output, status: "completed", createdAt: at(2).toISOString() });
    const failure = store.addActivity({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id,
      kind: "error", title: "Failed", detail: `Error: ${"x".repeat(5_000)}`, status: "failed", createdAt: at(3).toISOString() });
    const short = store.addActivity({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id,
      kind: "tool", title: "Read file", detail: "File: a.ts", status: "completed", createdAt: at(4).toISOString() });
    return { store, conversation, other, command, failure, short, output };
  }

  it("sends a bounded preview on history pages and the full output when asked", async () => {
    const { store, conversation, command, failure, short, output } = withActivities();
    const page = store.conversationHistory(conversation.id)!;
    const preview = page.activities.find(({ id }) => id === command.id)!;
    expect(preview.detailTruncated).toBe(true);
    expect(preview.detailBytes).toBe(Buffer.byteLength(output, "utf8"));
    expect(preview.detail!.startsWith(output.slice(0, ACTIVITY_DETAIL_PREVIEW_CHARS))).toBe(true);
    expect(preview.detail!.length).toBeLessThan(output.length);
    expect(preview.detail).toContain("Error:\nwarning: skipped 3 suites");
    expect(page.activities.find(({ id }) => id === failure.id)).toEqual(failure);
    expect(page.activities.find(({ id }) => id === short.id)).toEqual(short);
    expect(store.conversationDetail(conversation.id)!.activities.find(({ id }) => id === command.id)!.detail).toBe(output);
    const pageEvent: ServerEvent = { type: "request.result", requestId: "page", result: {
      kind: "conversation.detail", conversationId: conversation.id, state: "ready", detail: page } };
    expect(parseServerEvent(pageEvent)).toEqual(pageEvent);

    const sent: ServerEvent[] = [];
    const handler = createConversationReadCommandHandler({ store, send: (_socket, event) => { sent.push(event); } });
    await expect(handler({} as WebSocket, { type: "activity.detail.read", requestId: "read",
      payload: { conversationId: conversation.id, activityId: command.id } })).resolves.toBe("handled");
    expect(sent[0]).toEqual({ type: "request.result", requestId: "read", result: {
      kind: "activity.detail", conversationId: conversation.id, activityId: command.id, turnId: "turn-1", detail: output } });
    expect(parseServerEvent(sent[0]!)).toEqual(sent[0]);
  });

  it("refuses an activity read whose conversation does not own the activity", async () => {
    const { store, other, command } = withActivities();
    const sent: ServerEvent[] = [];
    const handler = createConversationReadCommandHandler({ store, send: (_socket, event) => { sent.push(event); } });
    await expect(handler({} as WebSocket, { type: "activity.detail.read", requestId: "read",
      payload: { conversationId: other.id, activityId: command.id } })).rejects.toThrow("no longer available");
    await expect(handler({} as WebSocket, { type: "activity.detail.read", requestId: "read",
      payload: { conversationId: other.id, activityId: randomUUID() } })).rejects.toThrow("no longer available");
    expect(sent).toEqual([]);
    expect(store.activityDetail(other.id, command.id)).toBeNull();
  });
});
