import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  ConversationContextService,
  createConversationContextPacketFromAuthorizedAgent,
} from "../../src/server/runtime/conversation-context-service";

const roots: string[] = [];

function fixture(): {
  store: RuntimeStore;
  databasePath: string;
  sourceId: string;
  targetId: string;
  otherId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "inertia-context-packets-"));
  roots.push(root);
  const firstWorkspace = join(root, "first");
  const secondWorkspace = join(root, "second");
  mkdirSync(firstWorkspace);
  mkdirSync(secondWorkspace);
  const databasePath = join(root, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, firstWorkspace, {
    recoverInterruptedRuns: false,
  });
  const first = store.createProject("First project", firstWorkspace);
  const second = store.createProject("Second project", secondWorkspace);
  const source = store.createConversation(first.id, "Architecture notes", {
    activate: false,
  });
  const target = store.createConversation(first.id, "Implementation", {
    activate: false,
  });
  const other = store.createConversation(second.id, "Other workspace", {
    activate: false,
  });
  return {
    store,
    databasePath,
    sourceId: source.id,
    targetId: target.id,
    otherId: other.id,
  };
}

function beginWithPacket(
  store: RuntimeStore,
  conversationId: string,
  packetIds: readonly string[],
  requestId = randomUUID(),
) {
  return store.beginAgentTurn({
    id: randomUUID(),
    conversationId,
    runId: randomUUID(),
    content: "Use the selected context and implement the change.",
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: "builtin:openai",
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: 0,
    association: "authoritative",
    conversationContextPacketIds: packetIds,
    contextRequestId: requestId,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("conversation context packets", () => {
  it("quotes only selected visible messages with provenance and defense-in-depth redaction", () => {
    const { store, sourceId, targetId } = fixture();
    const user = store.createMessage(
      sourceId,
      "The cache key must include the workspace identity.",
      "user",
      [],
      null,
      "2026-08-19T08:00:00.000Z",
    );
    const assistant = store.createMessage(
      sourceId,
      "Use OPENAI_API_KEY=sk-secret-value-123456789 while testing.",
      "assistant",
      [],
      null,
      "2026-08-19T08:00:01.000Z",
    );
    store.createMessage(sourceId, "Internal transcript marker", "system");
    store.updateConversation(sourceId, {
      providerSessionId: "provider-session-must-not-cross-chat-boundaries",
    });
    const packet = new ConversationContextService(store).createFromRenderer({
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceMessageIds: [assistant.id, user.id],
      note: "Carry the decision forward.",
      acknowledgedWorkspaceDifference: false,
    });

    expect(packet).toMatchObject({
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceConversationTitle: "Architecture notes",
      sourceProjectName: "First project",
      workspaceRelation: "same-workspace",
      sourceState: "available",
      messageCount: 2,
      consumedMessageId: null,
    });
    expect(packet.excerpts.map(({ sourceMessageId }) => sourceMessageId))
      .toEqual([user.id, assistant.id]);
    expect(JSON.stringify(packet.excerpts)).not.toContain("sk-secret-value");
    expect(JSON.stringify(packet.excerpts)).toContain("[redacted]");
    expect(store.conversationDetail(targetId)?.contextPackets)
      .toEqual([expect.objectContaining({ id: packet.id })]);
    const materialized = store.contextPackets.materialize(targetId, [packet.id]);
    expect(materialized[0]?.content).not.toContain("provider-session-must-not-cross");
    expect(materialized[0]?.content).not.toContain("sk-secret-value");
    expect(materialized[0]?.content).not.toContain("continuationIdentity");
    store.close();
  });

  it("does not treat an arbitrary confirmation string as agent authority", () => {
    const { store, sourceId, targetId } = fixture();
    const sourceMessage = store.createMessage(sourceId, "Approved decision", "user");
    const liveReceipts = new WeakSet<object>();
    const verifier = {
      isAuthorized: (receipt: object): boolean => liveReceipts.has(receipt),
    };

    expect(() => createConversationContextPacketFromAuthorizedAgent(store, {
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceMessageIds: [sourceMessage.id],
      acknowledgedWorkspaceDifference: false,
      authorizationReceipt: "looks-approved",
    }, verifier)).toThrow("explicit user confirmation");
    expect(store.conversationDetail(targetId)?.contextPackets).toEqual([]);

    const oneShotReceipt = {};
    liveReceipts.add(oneShotReceipt);
    expect(createConversationContextPacketFromAuthorizedAgent(store, {
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceMessageIds: [sourceMessage.id],
      acknowledgedWorkspaceDifference: false,
      authorizationReceipt: oneShotReceipt,
    }, verifier)).toMatchObject({ targetConversationId: targetId });
    store.close();
  });

  it("requires an explicit acknowledgement across project or worktree boundaries", () => {
    const { store, sourceId, otherId } = fixture();
    const message = store.createMessage(sourceId, "Portable decision", "user");
    expect(() => store.contextPackets.create({
      sourceConversationId: sourceId,
      targetConversationId: otherId,
      sourceMessageIds: [message.id],
      acknowledgedWorkspaceDifference: false,
    })).toThrow("different project or worktree");

    const packet = store.contextPackets.create({
      sourceConversationId: sourceId,
      targetConversationId: otherId,
      sourceMessageIds: [message.id],
      acknowledgedWorkspaceDifference: true,
    });
    expect(packet.workspaceRelation).toBe("different-workspace");
    expect(packet.sourceWorkspaceLabel).toBe("Project checkout");
    expect(packet.targetWorkspaceLabel).toBe("Project checkout");
    store.close();
  });

  it("binds source previews to the exact target and derives workspace scope server-side", () => {
    const { store, sourceId, targetId, otherId } = fixture();
    store.createMessage(sourceId, "Scoped decision", "user");

    expect(store.contextPackets.sourceTranscript(sourceId, targetId)).toMatchObject({
      conversationId: sourceId,
      targetConversationId: targetId,
      workspaceRelation: "same-workspace",
    });
    expect(store.contextPackets.sourceTranscript(sourceId, otherId)).toMatchObject({
      conversationId: sourceId,
      targetConversationId: otherId,
      workspaceRelation: "different-workspace",
    });
    expect(() => store.contextPackets.sourceTranscript(sourceId, sourceId))
      .toThrow("Choose another chat");
    store.close();
  });

  it("claims packets atomically, replays the same request, and rejects a new dispatch", () => {
    const { store, sourceId, targetId } = fixture();
    const sourceMessage = store.createMessage(sourceId, "One decision", "user");
    const packet = store.contextPackets.create({
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceMessageIds: [sourceMessage.id],
      acknowledgedWorkspaceDifference: false,
    });
    const requestId = randomUUID();
    const queued = beginWithPacket(store, targetId, [packet.id], requestId);
    expect(store.contextPackets.get(packet.id, targetId)).toMatchObject({
      consumedMessageId: queued.message.id,
    });
    expect(store.contextPackets.replayAcceptance(
      requestId,
      targetId,
      [packet.id],
    )).toEqual({
      kind: "message.accepted",
      conversationId: targetId,
      turnId: queued.turn.id,
      userMessageId: queued.message.id,
      disposition: "new-turn",
    });
    expect(() => beginWithPacket(store, targetId, [packet.id]))
      .toThrow("already sent");
    expect(store.conversationDetail(targetId)?.messages).toHaveLength(1);
    store.close();
  });

  it("rejects a retry that omits part of the originally consumed packet set", () => {
    const { store, sourceId, targetId } = fixture();
    const firstMessage = store.createMessage(sourceId, "First decision", "user");
    const secondMessage = store.createMessage(sourceId, "Second decision", "assistant");
    const packets = [firstMessage, secondMessage].map((message) =>
      store.contextPackets.create({
        sourceConversationId: sourceId,
        targetConversationId: targetId,
        sourceMessageIds: [message.id],
        acknowledgedWorkspaceDifference: false,
      }));
    const requestId = randomUUID();
    beginWithPacket(store, targetId, packets.map(({ id }) => id), requestId);

    expect(() => store.contextPackets.replayAcceptance(
      requestId,
      targetId,
      [packets[0]!.id],
    )).toThrow("retried chat context request is inconsistent");
    expect(store.conversationDetail(targetId)?.messages).toHaveLength(1);
    store.close();
  });

  it("bounds pending context packets at both the repository and SQL boundaries", () => {
    const { store, databasePath, sourceId, targetId } = fixture();
    const messages = ["First draft", "Second draft", "Overflow draft"].map(
      (content) => store.createMessage(sourceId, content, "user"),
    );
    const packets = messages.slice(0, 2).map((message) =>
      store.contextPackets.create({
        sourceConversationId: sourceId,
        targetConversationId: targetId,
        sourceMessageIds: [message.id],
        acknowledgedWorkspaceDifference: false,
      }));
    expect(() => store.contextPackets.create({
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceMessageIds: [messages[2]!.id],
      acknowledgedWorkspaceDifference: false,
    })).toThrow("Send or remove one");
    store.close();

    const database = new Database(databasePath);
    expect(() => database.prepare(`
      INSERT INTO conversation_context_packets
      SELECT ?, source_conversation_id, target_conversation_id,
        source_project_id, target_project_id, source_conversation_title,
        source_project_name, source_workspace_label, target_workspace_label,
        workspace_relation, note, excerpts_json, message_count,
        character_count, created_at, NULL, NULL, NULL
      FROM conversation_context_packets WHERE id = ?
    `).run(randomUUID(), packets[0]!.id)).toThrow(
      "conversation context draft limit reached",
    );
    database.close();
  });

  it("recognizes an exact transcript-only retry without duplicating its message", () => {
    const { store, sourceId, targetId } = fixture();
    const sourceMessage = store.createMessage(sourceId, "One decision", "user");
    const packet = store.contextPackets.create({
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceMessageIds: [sourceMessage.id],
      acknowledgedWorkspaceDifference: false,
    });
    const requestId = randomUUID();
    store.createMessageWithContextPackets(
      targetId,
      "Use this decision.",
      [],
      [packet.id],
      requestId,
    );

    expect(store.contextPackets.replayAcceptance(
      requestId,
      targetId,
      [packet.id],
    )).toEqual({ kind: "transcript-only" });
    expect(store.conversationDetail(targetId)?.messages).toHaveLength(1);
    store.close();
  });

  it("rolls message and turn persistence back when any exact packet claim fails", () => {
    const { store, sourceId, targetId } = fixture();
    const sourceMessage = store.createMessage(sourceId, "Atomic decision", "user");
    const packet = store.contextPackets.create({
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceMessageIds: [sourceMessage.id],
      acknowledgedWorkspaceDifference: false,
    });
    expect(() => beginWithPacket(
      store,
      targetId,
      [packet.id, randomUUID()],
    )).toThrow("removed, already sent, or belongs to another chat");
    expect(store.conversationDetail(targetId)).toMatchObject({
      messages: [],
      agentTurns: [],
      contextPackets: [expect.objectContaining({
        id: packet.id,
        consumedMessageId: null,
      })],
    });
    store.close();
  });

  it("discards source drafts but retains sent evidence with a deleted-source label", () => {
    const { store, sourceId, targetId } = fixture();
    const first = store.createMessage(sourceId, "Draft evidence", "user");
    const second = store.createMessage(sourceId, "Sent evidence", "assistant");
    const draft = store.contextPackets.create({
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceMessageIds: [first.id],
      acknowledgedWorkspaceDifference: false,
    });
    const sent = store.contextPackets.create({
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceMessageIds: [second.id],
      acknowledgedWorkspaceDifference: false,
    });
    beginWithPacket(store, targetId, [sent.id]);

    store.deleteConversation(sourceId);

    expect(() => store.contextPackets.get(draft.id, targetId))
      .toThrow("unavailable");
    expect(store.contextPackets.get(sent.id, targetId)).toMatchObject({
      id: sent.id,
      sourceState: "deleted",
      excerpts: [expect.objectContaining({ content: "Sent evidence" })],
    });
    store.close();
  });

  it("enforces immutable provenance at the storage boundary", () => {
    const { store, databasePath, sourceId, targetId } = fixture();
    const message = store.createMessage(sourceId, "Immutable decision", "user");
    const packet = store.contextPackets.create({
      sourceConversationId: sourceId,
      targetConversationId: targetId,
      sourceMessageIds: [message.id],
      acknowledgedWorkspaceDifference: false,
    });
    store.close();

    const database = new Database(databasePath);
    expect(() => database.prepare(`
      UPDATE conversation_context_packets SET note = 'rewritten' WHERE id = ?
    `).run(packet.id)).toThrow("conversation context packets are immutable");
    expect(database.prepare(`
      SELECT source_conversation_title AS title
      FROM conversation_context_packets WHERE id = ?
    `).get(packet.id)).toEqual({ title: "Architecture notes" });
    database.close();
  });
});
