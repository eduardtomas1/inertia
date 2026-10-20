import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { publicRuntimeError } from "../../src/server/runtime-errors";
import {
  createRuntimeCommandExecutor,
  defineRuntimeCommandHandler,
  RUNTIME_COMMAND_TYPES,
} from "../../src/server/runtime/commands/command-router";
import { createInitiativeCommandHandler } from "../../src/server/runtime/commands/initiative-commands";
import { ConversationCreationService } from "../../src/server/runtime/conversation-creation-service";
import { detachedChatCommandRejection } from "../../src/server/runtime/detached-chat-runtime-policy";
import { projectDetachedChatSnapshot } from "../../src/server/runtime/detached-chat-runtime-projection";
import { ensureInitiativeSkillsFolder } from "../../src/server/runtime/initiative-skills-folder";
import type { ClientCommand, ModelSelection, ServerEvent } from "../../src/shared/contracts";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { providerIdForHarness } from "../../src/shared/model-routing";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import { defaultInitiativePreferences, INITIATIVE_BRIEF_CONFLICT_MESSAGE } from "../../src/shared/initiatives";

const roots: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const socket = {} as WebSocket;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inertia-initiative-commands-"));
  roots.push(root);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Initiatives", root);
  const events: ServerEvent[] = [];
  const order: string[] = [];
  const broadcastSnapshot = vi.fn(() => { order.push("snapshot"); });
  const send = vi.fn((_socket: WebSocket, event: ServerEvent) => {
    order.push(event.type);
    events.push(event);
  });
  const validateDefaultModel = vi.fn((selection: ModelSelection) => selection);
  const ensureSkillsFolder = vi.fn((initiativeId: string) => { ensureInitiativeSkillsFolder(root, initiativeId); });
  const handler = createInitiativeCommandHandler({ store, send, validateDefaultModel, ensureSkillsFolder });
  const execute = createRuntimeCommandExecutor({
    handlers: [
      handler,
      defineRuntimeCommandHandler(
        RUNTIME_COMMAND_TYPES.filter((type) => !handler.commandTypes?.includes(type)),
        async () => "not-handled",
      ),
    ],
    send,
    broadcastSnapshot,
    publicError: publicRuntimeError,
  });
  const run = async (type: ClientCommand["type"], payload: unknown) => {
    const command = clientCommandSchema.parse({ type, requestId: randomUUID(), payload });
    events.length = 0;
    order.length = 0;
    await execute(socket, command);
    return { command, events: [...events], order: [...order] };
  };
  const creation = new ConversationCreationService({
    store,
    providers: {
      resolveModelRoute: (selection: { harnessId: string }) => ({ providerId: providerIdForHarness(selection.harnessId) }),
    } as never,
    backendProfileController: { validateSelection: (selection: unknown) => selection } as never,
    workspaceRuns: {} as never,
    dataDirectory: root,
    broadcastSnapshot: () => undefined,
  });
  return { root, store, project, handler, run, creation, validateDefaultModel, ensureSkillsFolder };
}

function parses(type: ClientCommand["type"], payload: unknown): boolean {
  return clientCommandSchema.safeParse({ type, requestId: randomUUID(), payload }).success;
}

describe("initiative command handler", () => {
  it("owns exactly the initiative commands", () => {
    const { handler } = fixture();
    expect([...(handler.commandTypes ?? [])].sort()).toEqual([
      "initiative.assign",
      "initiative.brief.update",
      "initiative.create",
      "initiative.delete",
      "initiative.note.create",
      "initiative.note.delete",
      "initiative.note.resolve",
      "initiative.note.update",
      "initiative.notes.list",
      "initiative.update",
    ]);
  });

  it("creates, updates, assigns and deletes initiatives as snapshot mutations", async () => {
    const { store, project, run } = fixture();
    const conversation = store.createConversation(project.id, "Member");
    const id = randomUUID();

    const created = await run("initiative.create", { id, name: "Checkout", color: "blue" });
    expect(created.order).toEqual(["snapshot", "request.ok"]);
    expect(store.shellSnapshot().initiatives).toEqual([
      expect.objectContaining({ id, name: "Checkout", color: "blue", status: "active", revision: 1 }),
    ]);

    const updated = await run("initiative.update", { id, expectedRevision: 1, name: "Checkout v2", status: "done" });
    expect(updated.order).toEqual(["snapshot", "request.ok"]);
    expect(store.initiatives.get(id)).toMatchObject({ name: "Checkout v2", status: "done", revision: 2 });
    await run("initiative.update", { id, expectedRevision: 2, status: "active" });

    const assigned = await run("initiative.assign", { conversationId: conversation.id, initiativeId: id });
    expect(assigned.order).toEqual(["snapshot", "request.ok"]);
    expect(store.conversationShell(conversation.id)?.initiativeId).toBe(id);

    const cleared = await run("initiative.assign", { conversationId: conversation.id, initiativeId: null });
    expect(cleared.order).toEqual(["snapshot", "request.ok"]);
    expect(store.conversationShell(conversation.id)?.initiativeId).toBeNull();

    await run("initiative.assign", { conversationId: conversation.id, initiativeId: id });
    const deleted = await run("initiative.delete", { id });
    expect(deleted.order).toEqual(["snapshot", "request.ok"]);
    expect(store.shellSnapshot().initiatives).toEqual([]);
    expect(store.conversationShell(conversation.id)).toMatchObject({ id: conversation.id, initiativeId: null });
  });

  it("creates an initiative and moves a chat into it with one command", async () => {
    const { store, project, run } = fixture();
    const conversation = store.createConversation(project.id, "First");
    const id = randomUUID();
    const result = await run("initiative.create", { id, name: "From the menu", conversationId: conversation.id });
    expect(result.order).toEqual(["snapshot", "request.ok"]);
    expect(store.conversationShell(conversation.id)?.initiativeId).toBe(id);
  });

  it("preserves every other chat identity when membership changes", async () => {
    const { store, project, run } = fixture();
    const conversation = store.createConversation(project.id, "Identity", { branch: "main" });
    const before = store.conversationShell(conversation.id)!;
    const id = randomUUID();
    await run("initiative.create", { id, name: "Identity" });
    await run("initiative.assign", { conversationId: conversation.id, initiativeId: id });
    const after = store.conversationShell(conversation.id)!;
    expect(after).toMatchObject({
      id: before.id,
      projectId: project.id,
      providerId: before.providerId,
      modelSelection: before.modelSelection,
      branch: "main",
      worktreePath: before.worktreePath,
      providerSessionId: before.providerSessionId,
      updatedAt: before.updatedAt,
      initiativeId: id,
    });
    expect(store.snapshot().activeConversationId).toBe(conversation.id);
  });

  it("rejects archived, done and missing targets with renderer-visible errors", async () => {
    const { store, project, run } = fixture();
    const conversation = store.createConversation(project.id, "Member");
    const id = randomUUID();
    await run("initiative.create", { id, name: "Archived" });
    await run("initiative.update", { id, expectedRevision: 1, status: "archived" });

    const archived = await run("initiative.assign", { conversationId: conversation.id, initiativeId: id });
    expect(archived.order).toEqual(["request.error"]);
    expect(archived.events[0]).toMatchObject({
      type: "request.error",
      message: "Only active initiatives can take chats. Reopen the initiative first.",
    });
    await run("initiative.update", { id, expectedRevision: 2, status: "done" });
    const done = await run("initiative.assign", { conversationId: conversation.id, initiativeId: id });
    expect(done.events[0]).toMatchObject({ type: "request.error" });

    const missing = await run("initiative.assign", { conversationId: conversation.id, initiativeId: randomUUID() });
    expect(missing.events[0]).toMatchObject({ type: "request.error", message: "That initiative no longer exists." });
    const stale = await run("initiative.update", { id, expectedRevision: 1, name: "Stale" });
    expect(stale.events[0]).toMatchObject({
      type: "request.error",
      message: "The initiative changed elsewhere. Review the latest version and try again.",
    });
    expect(store.conversationShell(conversation.id)?.initiativeId).toBeNull();
  });

  it("rejects malformed payloads at the protocol boundary", () => {
    const id = randomUUID();
    expect(parses("initiative.create", { id, name: "Valid" })).toBe(true);
    expect(parses("initiative.create", { id, name: "Valid", color: "teal", conversationId: randomUUID() })).toBe(true);
    for (const payload of [
      { name: "Missing id" },
      { id: "not-a-uuid", name: "Id" },
      { id, name: "" },
      { id, name: "   " },
      { id, name: "x".repeat(121) },
      { id, name: "Two\nlines" },
      { id, name: "Tab\tinside" },
      { id, name: "Colour", color: "#ff0000" },
      { id, name: "Extra", brief: "Later" },
    ]) {
      expect(parses("initiative.create", payload)).toBe(false);
    }
    expect(parses("initiative.update", { id, expectedRevision: 1, status: "archived" })).toBe(true);
    // Revisions mirror the SQL column, which starts at 0 for rows written without one.
    expect(parses("initiative.update", { id, expectedRevision: 0, name: "  Trimmed  " })).toBe(true);
    for (const payload of [
      { id, status: "done" },
      { id, expectedRevision: -1, status: "done" },
      { id, expectedRevision: 1, name: "Tab\tinside" },
      { id, expectedRevision: 1 },
      { id, expectedRevision: 1, status: "paused" },
      { id, expectedRevision: 1, brief: "Later" },
    ]) {
      expect(parses("initiative.update", payload)).toBe(false);
    }
    expect(parses("initiative.assign", { conversationId: randomUUID(), initiativeId: null })).toBe(true);
    expect(parses("initiative.assign", { conversationId: randomUUID() })).toBe(false);
    expect(parses("initiative.assign", { conversationId: "chat", initiativeId: id })).toBe(false);
    expect(parses("initiative.delete", { id: "nope" })).toBe(false);
    expect(parses("conversation.create", { projectId: randomUUID(), title: "New", initiativeId: id })).toBe(true);
    expect(parses("conversation.create", { projectId: randomUUID(), title: "New", initiativeId: "nope" })).toBe(false);
  });

  it("joins an active initiative at chat creation and refuses inactive ones before any checkout work", async () => {
    const { store, project, run, creation } = fixture();
    const id = randomUUID();
    await run("initiative.create", { id, name: "Creation" });
    const created = await creation.create({ projectId: project.id, title: "Joined", initiativeId: id }, randomUUID());
    expect(created).toMatchObject({ projectId: project.id, initiativeId: id });
    expect(store.conversationShell(created.id)?.initiativeId).toBe(id);

    const scratch = await creation.ensureScratchProject();
    const free = await creation.create({ projectId: scratch.id, title: "No project", initiativeId: id }, randomUUID());
    expect(store.conversationShell(free.id)).toMatchObject({ projectId: scratch.id, initiativeId: id });

    await run("initiative.update", { id, expectedRevision: 1, status: "archived" });
    const before = store.shellSnapshot().conversations.length;
    await expect(creation.create({ projectId: project.id, title: "Refused", initiativeId: id, useWorktree: true }, randomUUID()))
      .rejects.toThrow("Only active initiatives can take chats. Reopen the initiative first.");
    expect(store.shellSnapshot().conversations).toHaveLength(before);
  });

  it("rejects every initiative command in a detached chat window, even for its own chat", () => {
    const { store, project } = fixture();
    const conversation = store.createConversation(project.id, "Detached");
    const snapshot = store.shellSnapshot();
    const resources = {
      snapshot: () => snapshot,
      subagentConversationId: () => null,
      checkpointConversationId: () => null,
      pendingApproval: () => null,
      pendingInput: () => null,
    };
    const authority = { kind: "detached-chat" as const, conversationId: conversation.id, clientId: "window-1" };
    const id = randomUUID();
    for (const [type, payload] of [
      ["initiative.create", { id, name: "From a window", conversationId: conversation.id }],
      ["initiative.update", { id, expectedRevision: 1, name: "Renamed" }],
      ["initiative.delete", { id }],
      ["initiative.assign", { conversationId: conversation.id, initiativeId: id }],
      ["initiative.brief.update", { id, expectedBriefRevision: 0, brief: "From a window" }],
      ["initiative.notes.list", { initiativeId: id }],
      ["initiative.note.create", { initiativeId: id, title: "From a window", body: "" }],
      ["initiative.note.update", { id, expectedRevision: 1, title: "Renamed" }],
      ["initiative.note.resolve", { id, expectedRevision: 1, decision: "accept" }],
      ["initiative.note.delete", { id }],
    ] as const) {
      const command = clientCommandSchema.parse({ type, requestId: randomUUID(), payload });
      expect(detachedChatCommandRejection(authority, command, resources))
        .toBe("That request is unavailable in a detached chat.");
      expect(detachedChatCommandRejection({ kind: "main" }, command, resources)).toBeNull();
    }
  });

  it("keeps only the detached chat's own initiative in its projected snapshot", () => {
    const { store, project } = fixture();
    const member = store.createConversation(project.id, "Member");
    const other = store.createConversation(project.id, "Other");
    const mine = store.initiatives.create({ id: randomUUID(), name: "Mine" }, member.id);
    const theirs = store.initiatives.create({ id: randomUUID(), name: "Theirs" }, other.id);
    const projected = projectDetachedChatSnapshot(store.shellSnapshot(), member.id);
    expect(projected.initiatives?.map(({ id }) => id)).toEqual([mine.id]);
    expect(JSON.stringify(projected)).not.toContain(theirs.name);
    expect(projectDetachedChatSnapshot(store.shellSnapshot(), store.createConversation(project.id, "Free").id).initiatives)
      .toEqual([]);

    // Of the shared settings, only the access ceiling reaches the window.
    store.initiatives.update(mine.id, mine.revision, {
      preferences: { accessCeiling: "auto-edit", defaultProjectId: project.id, browserAccess: false, skillsFolder: false },
    });
    expect(projectDetachedChatSnapshot(store.shellSnapshot(), member.id).initiatives?.[0]?.preferences)
      .toEqual({ ...defaultInitiativePreferences(), accessCeiling: "auto-edit" });
  });
});

describe("initiative brief and note commands", () => {
  it("saves the brief as a snapshot mutation and reports a stale save as a conflict", async () => {
    const { store, run } = fixture();
    const id = randomUUID();
    await run("initiative.create", { id, name: "Checkout" });
    const saved = await run("initiative.brief.update", { id, expectedBriefRevision: 0, brief: "Ship it." });
    expect(saved.order).toEqual(["snapshot", "request.ok"]);
    expect(store.initiatives.get(id)).toMatchObject({ brief: "Ship it.", briefRevision: 1, revision: 2 });
    const stale = await run("initiative.brief.update", { id, expectedBriefRevision: 0, brief: "Overwrite" });
    expect(stale.events).toEqual([expect.objectContaining({ type: "request.error", message: INITIATIVE_BRIEF_CONFLICT_MESSAGE })]);
    expect(store.initiatives.get(id)?.brief).toBe("Ship it.");
  });

  it("lists, creates, edits, reviews and deletes notes", async () => {
    const { store, run } = fixture();
    const id = randomUUID();
    await run("initiative.create", { id, name: "Checkout" });
    const created = await run("initiative.note.create", { initiativeId: id, title: "  Database  ", body: "Use Postgres." });
    expect(created.order).toEqual(["snapshot", "request.ok"]);
    const [note] = store.initiatives.notes.list(id);
    // Notes written in Inertia are the user's and apply at once.
    expect(note).toMatchObject({ title: "Database", provenance: "user", state: "accepted" });
    expect(store.initiatives.get(id)?.notesRevision).toBe(1);

    const proposal = store.initiatives.notes.create({ initiativeId: id, title: "Agent idea", body: "", provenance: "agent" });
    const rejected = store.initiatives.notes.create({ initiativeId: id, title: "Rejected", body: "", provenance: "agent" });
    store.initiatives.notes.resolve(rejected.id, 1, "reject");

    const listed = await run("initiative.notes.list", { initiativeId: id });
    // A read: no snapshot, one result with every note, rejected ones included
    // so the page can list and delete them.
    expect(listed.order).toEqual(["request.result"]);
    expect(listed.events[0]).toEqual({
      type: "request.result",
      requestId: listed.command.requestId,
      result: {
        kind: "initiative.notes",
        initiativeId: id,
        notes: store.initiatives.notes.list(id, { includeRejected: true }),
      },
    });
    expect(parseServerEvent(listed.events[0])).not.toBeNull();
    expect((listed.events[0] as { result: { notes: Array<{ state: string }> } }).result.notes
      .map(({ state }) => state).sort()).toEqual(["accepted", "proposed", "rejected"]);

    await run("initiative.note.update", { id: note!.id, expectedRevision: 1, body: "Use Postgres 16." });
    expect(store.initiatives.notes.get(note!.id)).toMatchObject({ body: "Use Postgres 16.", revision: 2 });
    expect(store.initiatives.get(id)?.notesRevision).toBe(2);
    await run("initiative.note.resolve", { id: proposal.id, expectedRevision: 1, decision: "accept", title: "Cache totals" });
    expect(store.initiatives.notes.get(proposal.id)).toMatchObject({ state: "accepted", title: "Cache totals", provenance: "agent" });
    const stale = await run("initiative.note.update", { id: note!.id, expectedRevision: 1, title: "Stale" });
    expect(stale.events).toEqual([expect.objectContaining({
      type: "request.error", message: "The note changed elsewhere. Reload to see the latest.",
    })]);
    await run("initiative.note.delete", { id: note!.id });
    expect(store.initiatives.notes.get(note!.id)).toBeNull();
    const missing = await run("initiative.notes.list", { initiativeId: randomUUID() });
    expect(missing.events).toEqual([expect.objectContaining({ type: "request.error", message: "That initiative no longer exists." })]);
  });

  it("rejects malformed brief and note payloads at the protocol boundary", () => {
    const id = randomUUID();
    expect(parses("initiative.brief.update", { id, expectedBriefRevision: 0, brief: "" })).toBe(true);
    expect(parses("initiative.brief.update", { id, expectedBriefRevision: 0, brief: "😀".repeat(2_048) })).toBe(true);
    for (const payload of [
      { id, brief: "Missing revision" },
      { id, expectedBriefRevision: -1, brief: "x" },
      { id, expectedBriefRevision: 0, brief: `${"😀".repeat(2_048)}x` },
      { id, expectedBriefRevision: 0, brief: "nul\0" },
      { id, expectedBriefRevision: 0, brief: "x", name: "Extra" },
    ]) {
      expect(parses("initiative.brief.update", payload)).toBe(false);
    }
    expect(parses("initiative.note.create", { initiativeId: id, title: " Title ", body: "" })).toBe(true);
    for (const payload of [
      { initiativeId: id, title: "", body: "" },
      { initiativeId: id, title: "Two\nlines", body: "" },
      { initiativeId: id, title: "Body", body: `${"😀".repeat(512)}x` },
      { initiativeId: id, title: "Agent", body: "", provenance: "agent" },
      { initiativeId: "nope", title: "Id", body: "" },
    ]) {
      expect(parses("initiative.note.create", payload)).toBe(false);
    }
    expect(parses("initiative.note.update", { id, expectedRevision: 1, body: "" })).toBe(true);
    expect(parses("initiative.note.update", { id, expectedRevision: 1 })).toBe(false);
    expect(parses("initiative.note.resolve", { id, expectedRevision: 1, decision: "accept", title: "Edited" })).toBe(true);
    expect(parses("initiative.note.resolve", { id, expectedRevision: 1, decision: "reject" })).toBe(true);
    expect(parses("initiative.note.resolve", { id, expectedRevision: 1, decision: "reject", body: "Edited" })).toBe(false);
    expect(parses("initiative.note.resolve", { id, expectedRevision: 1, decision: "maybe" })).toBe(false);
    expect(parses("initiative.note.delete", { id: "nope" })).toBe(false);
    expect(parses("initiative.notes.list", { initiativeId: id, state: "rejected" })).toBe(false);
  });
});
