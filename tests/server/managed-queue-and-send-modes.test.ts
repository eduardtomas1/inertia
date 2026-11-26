import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentApprovalRequest, AgentInputRequest } from "../../src/shared/contracts";
import type { ProviderHostToolCall } from "../../src/server/provider/contracts";
import { RuntimeStore } from "../../src/server/database";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import { ConversationContextRequestCoordinator } from "../../src/server/runtime/conversation-context-request-coordinator";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "inertia-managed-queue-tools-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace);
  const project = store.createProject("Queue Tools Project", workspace);
  const source = store.createConversation(project.id, "Parent chat", { accessMode: "supervised" });
  const sourceTurn = store.beginAgentTurn({
    id: "source-turn-1",
    conversationId: source.id,
    runId: "source-run-1",
    content: "Coordinate child",
    activateConversation: false,
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: source.modelSelection.backendProfileId,
    model: source.modelSelection.modelId,
    modelAlias: source.modelSelection.alias,
    reasoningEffort: source.modelSelection.reasoningEffort ?? "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: source.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;

  const active = new Map<string, { turnId: string; runId: string }>();
  let turnCounter = 0;
  let followUps = 0;
  const turns = {
    acquireTurnAdmission: async (conversationId: string) => active.has(conversationId) ? null
      : { conversationId, token: Symbol("admission"), release: () => undefined },
    isActive: (conversationId: string) => active.has(conversationId),
    activeConversationIds: () => [...active.keys()],
    activeIdentity: (conversationId: string) => active.get(conversationId) ?? null,
    queue: (request: { conversationId: string; content: string; activateConversation: boolean }) => {
      turnCounter += 1;
      const conversation = store.conversation(request.conversationId);
      return store.beginAgentTurn({
        id: `child-turn-${turnCounter}`,
        conversationId: conversation.id,
        runId: `child-run-${turnCounter}`,
        content: request.content,
        activateConversation: request.activateConversation,
        providerId: conversation.providerId,
        harnessId: conversation.modelSelection.harnessId,
        backendProfileId: conversation.modelSelection.backendProfileId,
        model: conversation.modelSelection.modelId,
        modelAlias: conversation.modelSelection.alias,
        reasoningEffort: conversation.modelSelection.reasoningEffort ?? "",
        interactionMode: conversation.interactionMode,
        accessMode: conversation.accessMode,
        providerSessionBefore: null,
        usageAtStart: null,
        configurationRevision: conversation.modelSelection.backendConfigurationRevision,
        association: "authoritative",
      });
    },
    start: (turnId: string) => {
      const turn = store.agentTurn(turnId);
      active.set(turn.conversationId, { turnId: turn.id, runId: turn.runId });
      return true;
    },
    failBeforeStart: vi.fn(),
    cancel: (conversationId: string) => active.delete(conversationId),
    cancelOwned: (conversationId: string, identity: { turnId: string; runId: string }) => {
      const current = active.get(conversationId);
      return current?.turnId === identity.turnId && current.runId === identity.runId ? active.delete(conversationId) : false;
    },
    cancelExact: vi.fn((conversationId: string, identity: { turnId: string; runId: string }) => {
      const current = active.get(conversationId);
      return current?.turnId === identity.turnId && current.runId === identity.runId ? active.delete(conversationId) : false;
    }),
    isReleasing: (conversationId: string) => active.has(conversationId),
    waitForProviderCleanup: async () => undefined,
    acquireFollowUpAdmission: (conversationId: string) => active.has(conversationId)
      ? { conversationId, ...active.get(conversationId)!, release: vi.fn() } : null,
    steer: async (lease: { turnId: string }) => {
      followUps += 1;
      return { kind: "accepted", message: { id: `follow-up-${followUps}`, turnId: lease.turnId } };
    },
    respondToInput: vi.fn(() => false),
  };

  const pendingInputs = new Map<string, AgentInputRequest>();
  const pendingApprovals = new Map<string, AgentApprovalRequest>();
  const messageQueue = { schedule: vi.fn() };
  const manager = new AgentThreadManager({
    store,
    providers: { resolveModelRoute: () => ({ providerId: "codex" }) } as never,
    backendProfileController: {
      validateSelection: (selection: typeof source.modelSelection) => selection,
      readiness: async () => null,
    } as never,
    creation: {
      create: async (payload: Parameters<RuntimeStore["createConversation"]>[2] & { projectId: string; title: string }) =>
        store.createConversation(payload.projectId, payload.title, { ...payload, activate: false }),
    } as never,
    turns: turns as never,
    providerTerminalResumes: { isActive: () => false, acquire: () => true, release: () => undefined },
    contextRequests: new ConversationContextRequestCoordinator({
      pendingInputs,
      contextPackets: store.contextPackets,
      broadcast: vi.fn(),
      broadcastConversationShell: vi.fn(),
    }),
    pendingInputs,
    pendingApprovals,
    messageQueue: () => messageQueue,
    providerInfo: () => [{ id: "codex", canRun: true, statusMessage: null }] as never,
    broadcastSnapshot: vi.fn(),
    broadcastConversationShell: vi.fn(),
    broadcast: vi.fn(),
    now: () => "2026-11-26T20:00:00.000Z",
  });

  const toolCall = (tool: string, args: Record<string, unknown>): ProviderHostToolCall => ({
    tool,
    toolCallId: `${tool}-${crypto.randomUUID()}`,
    providerThreadId: "thread-1",
    providerTurnId: "turn-1",
    arguments: args,
    signal: new AbortController().signal,
    requestApproval: vi.fn(async () => "approve" as const),
  });

  const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn });
  const created = await bridge.invoke(toolCall("inertia_create_conversation", { title: "Child", prompt: "Start" }));
  const { conversationId: childId } = JSON.parse(created.text) as { conversationId: string };
  return { store, project, source, sourceTurn, bridge, childId, toolCall };
}

describe("D.7 inertia_queue tool and H2/G5 managed queue semantics", () => {
  it("supports list, bounded read (<= 16,000 chars), edit, reorder, promote_to_steer, cancel, and blocks unmanaged chats", async () => {
    const env = await setup();
    try {
      const stranger = env.store.createConversation(env.project.id, "Unmanaged chat");
      const strangerRes = await env.bridge.invoke(env.toolCall("inertia_queue", { conversationId: stranger.id, action: "list" }));
      expect(strangerRes.success).toBe(false);
      expect(strangerRes.text).toContain("not a chat this chat created");

      const itemA = env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: "x".repeat(17_500),
        createdBy: "agent",
        creationSource: "mcp",
      }).value.id;
      const itemB = env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: "Second item",
        createdBy: "agent",
        creationSource: "mcp",
      }).value.id;

      const listCall = env.toolCall("inertia_queue", { conversationId: env.childId, action: "list" });
      const listRes = JSON.parse((await env.bridge.invoke(listCall)).text);
      expect(listCall.requestApproval).not.toHaveBeenCalled();
      expect(listRes).toMatchObject({ action: "list", count: 2 });
      expect(listRes.items.map((item: { itemId: string }) => item.itemId)).toEqual([itemA, itemB]);

      const readCall = env.toolCall("inertia_queue", { conversationId: env.childId, action: "read", itemId: itemA });
      const readRes = JSON.parse((await env.bridge.invoke(readCall)).text);
      expect(readCall.requestApproval).not.toHaveBeenCalled();
      expect(readRes.item.content.length).toBeLessThanOrEqual(16_000);
      expect(readRes.item.truncated).toBe(true);
      expect(readRes.item.totalChars).toBe(17_500);

      const editCall = env.toolCall("inertia_queue", {
        conversationId: env.childId, action: "edit", itemId: itemA, content: "Edited first item", expectedRevision: 0,
      });
      const editRes = JSON.parse((await env.bridge.invoke(editCall)).text);
      expect(editCall.requestApproval).toHaveBeenCalledOnce();
      expect(editRes.item.editRevision).toBe(1);
      expect(env.store.orchestration.queue.getContent(env.childId, itemA)?.content).toBe("Edited first item");

      const reorderCall = env.toolCall("inertia_queue", {
        conversationId: env.childId, action: "reorder", itemId: itemB, beforeItemId: itemA,
      });
      const reorderRes = JSON.parse((await env.bridge.invoke(reorderCall)).text);
      expect(reorderRes.items.map((item: { itemId: string }) => item.itemId)).toEqual([itemB, itemA]);

      const promoteCall = env.toolCall("inertia_queue", {
        conversationId: env.childId, action: "promote_to_steer", itemId: itemB,
      });
      const promoteRes = JSON.parse((await env.bridge.invoke(promoteCall)).text);
      expect(promoteRes).toMatchObject({ action: "promote_to_steer", itemId: itemB, disposition: "follow-up", accepted: true });
      expect(env.store.orchestration.queue.getItem(itemB)?.state).toBe("delivered");

      const cancelCall = env.toolCall("inertia_queue", {
        conversationId: env.childId, action: "cancel", itemId: itemA,
      });
      const cancelRes = JSON.parse((await env.bridge.invoke(cancelCall)).text);
      expect(cancelRes).toMatchObject({ action: "cancel", itemId: itemA, cancelled: true, state: "cancelled" });
      expect(env.store.orchestration.queue.listActive(env.childId)).toEqual([]);
    } finally {
      env.store.close();
    }
  });

  it("H2 & G5 receipt: inherits queueHeld on a held queue and replays agent-queue receipt cleanly", async () => {
    const env = await setup();
    try {
      env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: "Held user item",
        queueHeld: true,
      });
      const queuedCall = env.toolCall("inertia_send_message", {
        conversationId: env.childId, content: "Queued while held", mode: "queue",
      });
      const first = JSON.parse((await env.bridge.invoke(queuedCall)).text);
      expect(first).toMatchObject({ disposition: "queued", held: true, accepted: true });
      expect(env.store.orchestration.queue.getItem(first.queuedMessageId)?.queueHeld).toBe(true);
      const replayed = JSON.parse((await env.bridge.invoke(queuedCall)).text);
      expect(replayed.queuedMessageId).toBe(first.queuedMessageId);
    } finally {
      env.store.close();
    }
  });
});
