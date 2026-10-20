import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { InitiativeRepositoryError } from "../../src/server/persistence/initiative-repository";
import { InitiativeNoteRepository } from "../../src/server/persistence/initiative-note-repository";
import type { TurnInitiativeContextRecord } from "../../src/server/persistence/types";
import { publicRuntimeError } from "../../src/server/runtime-errors";
import { chatMessageSchema } from "../../src/shared/contracts/chat-message-schema";
import {
  INITIATIVE_BRIEF_CONFLICT_MESSAGE,
  INITIATIVE_NOTE_CONFLICT_MESSAGE,
  initiativeContextReceiptText,
  MAX_INITIATIVE_NOTES,
  MAX_REJECTED_INITIATIVE_NOTES,
  type InitiativeContextReceipt,
} from "../../src/shared/initiatives";
import { recordInitiativeContextDelivery } from "../../src/server/persistence/initiative-context-delivery-repository";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";

const temporaryDirectories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-initiative-notes-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "inertia.sqlite");
  const open = () => {
    const store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    stores.push(store);
    return store;
  };
  const store = open();
  const project = store.createProject("Initiative notes", directory);
  const initiative = store.initiatives.create({ id: randomUUID(), name: "Checkout redesign" });
  const conversation = store.createConversation(project.id, "Member chat");
  store.initiatives.assignConversation(conversation.id, initiative.id);
  return { store, open, databasePath, directory, project, initiative, conversation };
}

function failure(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

function beginTurn(
  store: RuntimeStore,
  conversationId: string,
  initiativeContext?: TurnInitiativeContextRecord,
  providerSessionBefore: string | null = null,
) {
  const conversation = store.conversation(conversationId);
  return store.beginAgentTurn({
    conversationId,
    runId: randomUUID(),
    content: "Continue the checkout work.",
    providerId: "codex",
    modelSelection: conversation.modelSelection,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
    providerSessionBefore,
    ...(initiativeContext ? { initiativeContext } : {}),
  });
}

function settle(
  store: RuntimeStore,
  turnId: string,
  terminalReason = "provider-completed",
  providerSessionAfter: string | null = null,
): void {
  const now = new Date().toISOString();
  store.settleAgentTurn(turnId, {
    status: terminalReason === "provider-completed" ? "completed" : "failed",
    terminalAssistantMessageId: null,
    providerSessionAfter,
    terminalReason,
    checkpointId: null,
    usageAtCompletion: null,
    startedAt: store.agentTurn(turnId).startedAt ?? now,
    completedAt: now,
    updatedAt: now,
  });
}

function record(
  initiativeId: string,
  briefRevision: number,
  notesRevision: number,
  count = 0,
): TurnInitiativeContextRecord {
  const receipt: InitiativeContextReceipt = {
    initiativeId,
    brief: { revision: briefRevision, change: "shared" },
    notes: count > 0 ? { revision: notesRevision, count, change: "shared" } : null,
  };
  return {
    receipt,
    receiptText: initiativeContextReceiptText(receipt),
    delivery: {
      initiativeId,
      initiativeName: "Checkout redesign",
      briefRevision,
      notesRevision: count > 0 ? notesRevision : null,
      notesDigest: count > 0 ? "a".repeat(64) : null,
    },
  };
}

describe("initiative brief", () => {
  it("moves the brief revision and the row revision, records when, and refuses a stale save", async () => {
    const { store, initiative } = await openStore();
    expect(initiative).toMatchObject({ briefRevision: 0, briefUpdatedAt: null, revision: 1 });
    const saved = store.initiatives.updateBrief(initiative.id, 0, "## Objective\n\nShip the new checkout.");
    expect(saved).toMatchObject({ brief: "## Objective\n\nShip the new checkout.", briefRevision: 1, revision: 2 });
    expect(saved.briefUpdatedAt).toBe(saved.updatedAt);
    expect(store.shellSnapshot().initiatives?.[0]).toEqual(saved);

    const stale = failure(() => store.initiatives.updateBrief(initiative.id, 0, "Overwrite"));
    expect(stale).toBeInstanceOf(InitiativeRepositoryError);
    expect(publicRuntimeError(stale)).toBe(INITIATIVE_BRIEF_CONFLICT_MESSAGE);
    expect(store.initiatives.get(initiative.id)?.brief).toBe(saved.brief);

    // Saving the same text is a no-op, so chats are not sent an unchanged brief.
    expect(store.initiatives.updateBrief(initiative.id, 1, saved.brief)).toEqual(saved);
    // The row revision moved, so a rename with the old revision is refused.
    expect(failure(() => store.initiatives.update(initiative.id, 1, { name: "Renamed" })))
      .toBeInstanceOf(InitiativeRepositoryError);
    expect(store.initiatives.update(initiative.id, 2, { name: "Renamed" })).toMatchObject({ briefRevision: 1, revision: 3 });
  });

  it("limits the brief to 8 KiB of UTF-8 and rejects NUL", async () => {
    const { store, initiative } = await openStore();
    expect(store.initiatives.updateBrief(initiative.id, 0, "😀".repeat(2_048)).briefRevision).toBe(1);
    expect(failure(() => store.initiatives.updateBrief(initiative.id, 1, `${"😀".repeat(2_048)}x`)))
      .toBeInstanceOf(InitiativeRepositoryError);
    expect(failure(() => store.initiatives.updateBrief(initiative.id, 1, "a\0b"))).toBeInstanceOf(InitiativeRepositoryError);
    expect(failure(() => store.initiatives.updateBrief(randomUUID(), 0, "Missing"))).toBeInstanceOf(InitiativeRepositoryError);
  });
});

describe("initiative notes", () => {
  it("accepts user notes at once and moves notes_revision only when accepted notes change", async () => {
    const { store, initiative } = await openStore();
    const notes = store.initiatives.notes;
    const revision = () => store.initiatives.get(initiative.id)!.notesRevision;

    const user = notes.create({ initiativeId: initiative.id, title: "  Database  ", body: "Use Postgres.", provenance: "user" });
    expect(user).toMatchObject({ title: "Database", state: "accepted", provenance: "user", revision: 1, sourceConversationId: null });
    expect(revision()).toBe(1);

    const proposal = notes.create({
      initiativeId: initiative.id, title: "Agent idea", body: "Cache totals.", provenance: "agent",
      sourceConversationId: store.shellSnapshot().conversations[0]!.id,
    });
    expect(proposal).toMatchObject({ state: "proposed", provenance: "agent" });
    expect(revision()).toBe(1);
    expect(store.initiatives.get(initiative.id)?.proposedNoteCount).toBe(1);

    // Editing a proposal does not change what chats receive.
    const editedProposal = notes.update(proposal.id, 1, { body: "Cache order totals." });
    expect(editedProposal).toMatchObject({ body: "Cache order totals.", revision: 2 });
    expect(revision()).toBe(1);

    const edited = notes.update(user.id, 1, { body: "Use Postgres 16." });
    expect(edited.revision).toBe(2);
    expect(revision()).toBe(2);
    // An unchanged edit is a no-op.
    expect(notes.update(user.id, 2, { body: "Use Postgres 16." })).toEqual(edited);
    expect(revision()).toBe(2);
    expect(publicRuntimeError(failure(() => notes.update(user.id, 1, { title: "Stale" }))))
      .toBe(INITIATIVE_NOTE_CONFLICT_MESSAGE);

    const accepted = notes.resolve(proposal.id, 2, "accept", { title: "Totals cache" });
    expect(accepted).toMatchObject({ state: "accepted", title: "Totals cache", provenance: "agent", revision: 3 });
    expect(revision()).toBe(3);
    expect(store.initiatives.get(initiative.id)?.proposedNoteCount).toBe(0);
    expect(failure(() => notes.resolve(proposal.id, 3, "reject"))).toBeInstanceOf(InitiativeRepositoryError);

    const second = notes.create({ initiativeId: initiative.id, title: "Rejected idea", body: "", provenance: "agent" });
    expect(failure(() => notes.resolve(second.id, 1, "reject", { title: "Edited" }))).toBeInstanceOf(InitiativeRepositoryError);
    expect(notes.resolve(second.id, 1, "reject")).toMatchObject({ state: "rejected" });
    expect(revision()).toBe(3);
    expect(failure(() => notes.update(second.id, 2, { title: "Edit a rejected note" }))).toBeInstanceOf(InitiativeRepositoryError);
    expect(notes.list(initiative.id).map(({ title }) => title)).toEqual(["Database", "Totals cache"]);
    expect(notes.list(initiative.id, { includeRejected: true }).map(({ state }) => state))
      .toEqual(["accepted", "accepted", "rejected"]);

    notes.delete(second.id);
    expect(revision()).toBe(3);
    notes.delete(user.id);
    expect(revision()).toBe(4);
    expect(notes.accepted(initiative.id).map(({ id }) => id)).toEqual([accepted.id]);
    expect(failure(() => notes.delete(user.id))).toBeInstanceOf(InitiativeRepositoryError);
    // The initiative's row revision never moves for notes.
    expect(store.initiatives.get(initiative.id)?.revision).toBe(initiative.revision);
  });

  it("validates titles and bodies and refuses notes on a missing initiative", async () => {
    const { store, initiative } = await openStore();
    const create = (title: string, body: string) => failure(() => store.initiatives.notes.create({
      initiativeId: initiative.id, title, body, provenance: "user",
    }));
    for (const [title, body] of [["", "x"], ["Two\nlines", ""], ["x".repeat(121), ""], ["Ok", `${"😀".repeat(512)}x`], ["Ok", "a\0"]]) {
      expect(create(title!, body!)).toBeInstanceOf(InitiativeRepositoryError);
    }
    expect(store.initiatives.notes.create({ initiativeId: initiative.id, title: "x".repeat(120), body: "😀".repeat(512), provenance: "user" }))
      .toMatchObject({ body: "😀".repeat(512) });
    expect(failure(() => store.initiatives.notes.create({
      initiativeId: randomUUID(), title: "Orphan", body: "", provenance: "user",
    }))).toBeInstanceOf(InitiativeRepositoryError);
  });

  it("keeps at most 64 accepted or proposed notes, in the repository and the SQL trigger", async () => {
    const { store, initiative, databasePath } = await openStore();
    for (let index = 0; index < MAX_INITIATIVE_NOTES; index += 1) {
      store.initiatives.notes.create({
        initiativeId: initiative.id, title: `Note ${index}`, body: "", provenance: index % 2 === 0 ? "user" : "agent",
      });
    }
    expect(publicRuntimeError(failure(() => store.initiatives.notes.create({
      initiativeId: initiative.id, title: "One too many", body: "", provenance: "user",
    })))).toBe("An initiative keeps at most 64 notes. Delete one first.");
    const raw = new Database(databasePath);
    try {
      const at = new Date().toISOString();
      const insert = raw.prepare(`
        INSERT INTO initiative_notes (id, initiative_id, title, body, provenance, state, created_at, updated_at)
        VALUES (?, ?, 'Raw', '', 'user', ?, ?, ?)
      `);
      expect(() => insert.run(randomUUID(), initiative.id, "accepted", at, at)).toThrow(/initiative note count limit exceeded/u);
      // Rejected notes are not counted.
      expect(() => insert.run(randomUUID(), initiative.id, "rejected", at, at)).not.toThrow();
      expect(() => insert.run(randomUUID(), initiative.id, "rejected", at, "short")).toThrow(/CHECK/u);
    } finally {
      raw.close();
    }
  });

  it("prunes the oldest rejected notes beyond the kept number", async () => {
    let tick = Date.parse("2026-10-19T10:00:00.000Z");
    const { store, initiative } = await openStore();
    const notes = new InitiativeNoteRepository(
      (store as unknown as { database: Database.Database }).database,
      () => new Date(tick += 1_000).toISOString(),
    );
    const rejected: string[] = [];
    for (let index = 0; index < MAX_REJECTED_INITIATIVE_NOTES + 2; index += 1) {
      const proposal = notes.create({ initiativeId: initiative.id, title: `Idea ${index}`, body: "", provenance: "agent" });
      notes.resolve(proposal.id, 1, "reject");
      rejected.push(proposal.id);
    }
    const kept = notes.list(initiative.id, { includeRejected: true }).map(({ id }) => id);
    expect(kept).toHaveLength(MAX_REJECTED_INITIATIVE_NOTES);
    expect(kept).toEqual(rejected.slice(2));
  });

  it("deletes notes and deliveries with their initiative, and forgets a deleted source chat", async () => {
    const { store, initiative, conversation, project } = await openStore();
    const source = store.createConversation(project.id, "Source chat");
    const proposal = store.initiatives.notes.create({
      initiativeId: initiative.id, title: "From an agent", body: "", provenance: "agent", sourceConversationId: source.id,
    });
    store.deleteConversation(source.id);
    expect(store.initiatives.notes.get(proposal.id)?.sourceConversationId).toBeNull();

    store.initiatives.notes.create({ initiativeId: initiative.id, title: "Kept", body: "", provenance: "user" });
    const { turn } = beginTurn(store, conversation.id, record(initiative.id, 0, 1, 1));
    settle(store, turn.id);
    expect(store.initiatives.deliveries.latestDelivered(conversation.id)).not.toBeNull();
    store.initiatives.delete(initiative.id);
    expect(store.initiatives.notes.list(initiative.id, { includeRejected: true })).toEqual([]);
    // The delivery keeps the name its session heard, so that session is told it no longer applies.
    expect(store.initiatives.deliveries.latestDelivered(conversation.id)).toMatchObject({
      initiativeId: null, initiativeName: "Checkout redesign", turnId: turn.id,
    });
    // The receipt stays: it describes what that turn carried.
    expect(store.conversationHistory(conversation.id)?.messages.some(({ initiativeContext }) => initiativeContext)).toBe(true);
  });
});

describe("initiative deliveries", () => {
  it("counts only deliveries whose turn reached the provider", async () => {
    const { store, initiative, conversation } = await openStore();
    const deliveries = store.initiatives.deliveries;
    expect(deliveries.latestDelivered(conversation.id)).toBeNull();

    const first = beginTurn(store, conversation.id, record(initiative.id, 1, 0));
    // Queued: not started yet.
    expect(deliveries.latestDelivered(conversation.id)).toBeNull();
    store.updateAgentTurnLifecycle(first.turn.id, { status: "running" });
    expect(deliveries.latestDelivered(conversation.id)).toMatchObject({
      initiativeId: initiative.id, turnId: first.turn.id, briefRevision: 1, notesRevision: null, notesDigest: null,
    });
    settle(store, first.turn.id, "provider-completed", "session-a");

    // A turn that never reached the provider leaves the earlier delivery in place.
    const lost = beginTurn(store, conversation.id, record(initiative.id, 2, 0));
    settle(store, lost.turn.id, "turn-start-failed");
    expect(deliveries.latestDelivered(conversation.id)?.turnId).toBe(first.turn.id);

    const second = beginTurn(store, conversation.id, record(initiative.id, 2, 0), "session-a");
    settle(store, second.turn.id, "provider-completed", "session-a");
    expect(deliveries.latestDelivered(conversation.id)?.briefRevision).toBe(2);
    expect(deliveries.latestDelivered(conversation.id, { providerSessionId: "session-a" })?.turnId).toBe(second.turn.id);
    // Another provider session has received nothing yet.
    expect(deliveries.latestDelivered(conversation.id, { providerSessionId: "session-b" })).toBeNull();

    // A turn without initiative context leaves no delivery.
    const plain = beginTurn(store, conversation.id);
    settle(store, plain.turn.id);
    expect(deliveries.latestDelivered(conversation.id)?.turnId).toBe(second.turn.id);
    store.deleteConversation(conversation.id);
    expect(deliveries.latestDelivered(conversation.id)).toBeNull();
  });

  it("replaces a turn's delivery and records one for an initiative deleted meanwhile by name only", async () => {
    const { store, initiative, conversation } = await openStore();
    const raw = (store as unknown as { database: Database.Database }).database;
    const { turn } = beginTurn(store, conversation.id);
    store.updateAgentTurnLifecycle(turn.id, { status: "running" });
    const write = (briefRevision: number, notesRevision: number | null) => recordInitiativeContextDelivery(raw, {
      conversationId: conversation.id,
      turnId: turn.id,
      deliveredAt: new Date().toISOString(),
      initiativeId: initiative.id,
      initiativeName: "Checkout redesign",
      briefRevision,
      notesRevision,
      notesDigest: notesRevision === null ? null : "b".repeat(64),
    });
    write(1, null);
    write(2, 1);
    expect(store.initiatives.deliveries.latestDelivered(conversation.id))
      .toMatchObject({ briefRevision: 2, notesRevision: 1, notesDigest: "b".repeat(64) });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM initiative_context_deliveries").get()).toEqual({ count: 1 });
    store.initiatives.delete(initiative.id);
    expect(() => write(3, 1)).not.toThrow();
    expect(store.initiatives.deliveries.latestDelivered(conversation.id)).toMatchObject({
      initiativeId: null, initiativeName: "Checkout redesign", briefRevision: 3,
    });
    // A notes revision always comes with the digest of the index it describes.
    expect(() => raw.prepare(`
      INSERT INTO initiative_context_deliveries (
        id, conversation_id, initiative_id, initiative_name, turn_id, brief_revision, notes_revision, notes_digest, delivered_at
      ) VALUES (?, ?, NULL, 'Name', ?, NULL, 1, NULL, ?)
    `).run(randomUUID(), conversation.id, beginTurn(store, conversation.id).turn.id, new Date().toISOString()))
      .toThrow(/CHECK/u);
  });
});

describe("initiative context of turns that never reached the provider", () => {
  const receiptsOf = (store: RuntimeStore, conversationId: string, turnId: string) =>
    (store.conversationHistory(conversationId)?.messages ?? [])
      .filter((message) => message.turnId === turnId && message.initiativeContext);
  const terminal = (store: RuntimeStore, turnId: string, status: "cancelled" | "interrupted" | "failed", terminalReason: string, providerReached?: boolean) => {
    const now = new Date().toISOString();
    store.settleAgentTurn(turnId, {
      status, terminalReason, providerSessionAfter: null, startedAt: store.agentTurn(turnId).startedAt ?? now,
      completedAt: now, updatedAt: now, ...(providerReached === undefined ? {} : { providerReached }),
    });
  };

  it("withdraws both when a started turn is stopped before its provider was handed the request", async () => {
    const { store, initiative, conversation } = await openStore();
    const { turn } = beginTurn(store, conversation.id, record(initiative.id, 1, 0));
    store.updateAgentTurnLifecycle(turn.id, { status: "starting" });
    terminal(store, turn.id, "cancelled", "user-cancelled", false);
    expect(receiptsOf(store, conversation.id, turn.id)).toEqual([]);
    expect(store.initiatives.deliveries.latestDelivered(conversation.id)).toBeNull();
  });

  it.each([
    ["interrupted", "provider-process-exit"],
    ["cancelled", "user-cancelled"],
  ] as const)("keeps both for a turn %s after its provider started", async (status, reason) => {
    const { store, initiative, conversation } = await openStore();
    const { turn } = beginTurn(store, conversation.id, record(initiative.id, 1, 0));
    store.updateAgentTurnLifecycle(turn.id, { status: "running" });
    terminal(store, turn.id, status, reason, true);
    expect(receiptsOf(store, conversation.id, turn.id)).toHaveLength(1);
    expect(store.initiatives.deliveries.latestDelivered(conversation.id)?.turnId).toBe(turn.id);
  });

  it("withdraws both for a turn still queued when the runtime stopped", async () => {
    const { store, databasePath, directory, initiative, conversation } = await openStore();
    const queued = beginTurn(store, conversation.id, record(initiative.id, 1, 0));
    expect(receiptsOf(store, conversation.id, queued.turn.id)).toHaveLength(1);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const recovered = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: true });
    stores.push(recovered);
    expect(recovered.agentTurn(queued.turn.id).status).toBe("interrupted");
    expect(receiptsOf(recovered, conversation.id, queued.turn.id)).toEqual([]);
    expect(recovered.initiatives.deliveries.latestDelivered(conversation.id)).toBeNull();
  });
});

describe("initiative context receipt", () => {
  it("persists a turn-scoped receipt with its delivery in the turn transaction and keeps it across a restart", async () => {
    const { store, open, initiative, conversation } = await openStore();
    const begun = beginTurn(store, conversation.id, record(initiative.id, 3, 1, 5));
    expect(begun.initiativeContextReceipt).toMatchObject({
      role: "system",
      turnId: begun.turn.id,
      content: "Shared the initiative brief (revision 3) and 5 notes with the agent.",
      initiativeContext: {
        initiativeId: initiative.id,
        brief: { revision: 3, change: "shared" },
        notes: { revision: 1, count: 5, change: "shared" },
      },
    });
    expect(chatMessageSchema(begun.initiativeContextReceipt)).toBe(true);
    expect(parseServerEvent({ type: "conversation.message.persisted", message: begun.initiativeContextReceipt }))
      .not.toBeNull();
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = open();
    const messages = reopened.conversationHistory(conversation.id)?.messages ?? [];
    expect(messages.filter(({ initiativeContext }) => initiativeContext)).toEqual([begun.initiativeContextReceipt]);
    expect(reopened.conversation(conversation.id).initiativeId).toBe(initiative.id);
  });

  it("rolls the request, turn and delivery back when the receipt cannot be written", async () => {
    const { store, initiative, conversation } = await openStore();
    expect(() => beginTurn(store, conversation.id, {
      ...record(initiative.id, 1, 0),
      receipt: { initiativeId: initiative.id, brief: null, notes: null },
    })).toThrow(/initiative context receipt/u);
    expect(store.conversationHistory(conversation.id)?.messages ?? []).toEqual([]);
    expect(store.latestAgentTurnForConversation(conversation.id)).toBeNull();
    const raw = (store as unknown as { database: Database.Database }).database;
    expect(raw.prepare("SELECT COUNT(*) AS count FROM initiative_context_deliveries").get()).toEqual({ count: 0 });
  });

  it("replaces the receipt when the turn restarts on a fresh provider session", async () => {
    const { store, initiative, conversation } = await openStore();
    store.updateConversation(conversation.id, { providerSessionId: "stale-session" });
    const begun = beginTurn(store, conversation.id, {
      ...record(initiative.id, 2, 1),
      receipt: { initiativeId: initiative.id, brief: { revision: 2, change: "updated" }, notes: null },
    }, "stale-session");
    const manifest = store.turnExecutionManifest(begun.turn.id);
    store.turnLedgerRepository.restartOnFreshSession(begun.turn.id, {
      expectedSessionId: "stale-session",
      executionContext: { manifest: manifest ?? emptyManifest(), blobs: [] },
      sessionRecovery: null,
      restartedAt: new Date().toISOString(),
      initiativeContext: record(initiative.id, 2, 1, 3),
    });
    const receipts = (store.conversationHistory(conversation.id)?.messages ?? [])
      .filter(({ initiativeContext }) => initiativeContext);
    expect(receipts.map(({ content }) => content)).toEqual([
      "Shared the initiative brief (revision 2) and 3 notes with the agent.",
    ]);

    // A fresh request that carries nothing removes the receipt and delivery.
    const again = beginTurn(store, conversation.id, record(initiative.id, 2, 1), null);
    store.updateConversation(conversation.id, { providerSessionId: "another-stale" });
    const raw = (store as unknown as { database: Database.Database }).database;
    raw.prepare("UPDATE agent_turns SET provider_session_before = 'another-stale' WHERE id = ?").run(again.turn.id);
    store.turnLedgerRepository.restartOnFreshSession(again.turn.id, {
      expectedSessionId: "another-stale",
      executionContext: { manifest: emptyManifest(), blobs: [] },
      sessionRecovery: null,
      restartedAt: new Date().toISOString(),
      initiativeContext: null,
    });
    expect((store.conversationHistory(conversation.id)?.messages ?? [])
      .filter(({ turnId, initiativeContext }) => turnId === again.turn.id && initiativeContext)).toEqual([]);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM initiative_context_deliveries WHERE turn_id = ?").get(again.turn.id))
      .toEqual({ count: 0 });
  });

  it("refuses receipt metadata on anything but a turn-scoped system message", async () => {
    const { store, initiative, conversation } = await openStore();
    const receipt = record(initiative.id, 1, 0).receipt;
    expect(() => store.createMessage(conversation.id, "Shared", "system", [], null, undefined, { initiativeContext: receipt }))
      .toThrow(/initiative context receipt/u);
    const { turn } = beginTurn(store, conversation.id);
    expect(() => store.createMessage(conversation.id, "Shared", "assistant", [], turn.id, undefined, { initiativeContext: receipt }))
      .toThrow(/initiative context receipt/u);
    expect(() => store.createMessage(conversation.id, "Shared", "system", [], turn.id, undefined, {
      initiativeContext: { ...receipt, brief: null },
    })).toThrow(/initiative context receipt/u);
  });
});

function emptyManifest() {
  return {
    version: 1 as const,
    visibleMessageBytes: 9,
    imageCount: 0,
    imageBytes: 0,
    contextReferenceCount: 0,
    uniqueContextBlobCount: 0,
    contextBytes: 0,
    internalInstructionCount: 0,
    internalInstructionBytes: 0,
    executionSegmentCount: 1,
    assembledPayloadBytes: 9,
    references: [],
  };
}
