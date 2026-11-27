import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentApprovalRequest, AgentInputRequest } from "../../src/shared/contracts";
import type { ProviderHostToolCall } from "../../src/server/provider/contracts";
import { RuntimeStore } from "../../src/server/database";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import { ConversationContextRequestCoordinator } from "../../src/server/runtime/conversation-context-request-coordinator";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setup(options: { orchestrated?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "inertia-managed-queue-tools-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace);
  const db = store.orchestration.effects.connection;
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
  const settleOrchestratedCancel = (conversationId: string, identity: { turnId: string; runId: string }): void => {
    if (!options.orchestrated) return;
    const target = store.orchestration.runControl.target(identity.runId);
    if (!target || target.terminal) return;
    const now = new Date().toISOString();
    store.updateAgentTurnLifecycle(identity.turnId, {
      status: "cancelled",
      terminalReason: "agent-cancelled",
      completedAt: now,
    });
    store.orchestration.synchronize(store.agentTurn(identity.turnId));
    store.orchestration.cleanup(identity, "confirmed");
    store.orchestration.runControl.settleInterrupt(identity.runId, "settled");
  };
  let steerHandler: (
    lease: { turnId: string; runId: string },
    input: { content: string },
    attachments: unknown,
    acknowledged?: () => void,
  ) => Promise<unknown> = async (lease, _input, _attachments, acknowledged) => {
    followUps += 1;
    acknowledged?.();
    return { kind: "accepted", message: { id: `follow-up-${followUps}`, turnId: lease.turnId } };
  };
  let failNextCleanup: Error | null = null;
  const turns = {
    acquireTurnAdmission: async (conversationId: string) => active.has(conversationId) ? null
      : { conversationId, token: Symbol("admission"), release: () => undefined },
    isActive: (conversationId: string) => active.has(conversationId),
    activeConversationIds: () => [...active.keys()],
    activeIdentity: (conversationId: string) => active.get(conversationId) ?? null,
    queue: (request: { conversationId: string; content: string; activateConversation: boolean; queuedMessageId?: string }) => {
      turnCounter += 1;
      const conversation = store.conversation(request.conversationId);
      const input = {
        id: `child-turn-${turnCounter}`,
        conversationId: conversation.id,
        runId: `child-run-${turnCounter}`,
        content: request.content,
        activateConversation: request.activateConversation,
        ...(request.queuedMessageId ? { queuedMessageId: request.queuedMessageId } : {}),
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
        association: "authoritative" as const,
      };
      return options.orchestrated
        ? store.beginOrchestratedAgentTurn(input)
        : store.beginAgentTurn(input);
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
      if (current?.turnId !== identity.turnId || current.runId !== identity.runId) return false;
      active.delete(conversationId);
      settleOrchestratedCancel(conversationId, identity);
      return true;
    },
    cancelExact: vi.fn((conversationId: string, identity: { turnId: string; runId: string }) => {
      const current = active.get(conversationId);
      if (current?.turnId !== identity.turnId || current.runId !== identity.runId) return false;
      active.delete(conversationId);
      settleOrchestratedCancel(conversationId, identity);
      return true;
    }),
    isReleasing: (conversationId: string) => active.has(conversationId),
    waitForProviderCleanup: async () => {
      if (failNextCleanup) {
        const error = failNextCleanup;
        failNextCleanup = null;
        throw error;
      }
      return undefined;
    },
    acquireFollowUpAdmission: (conversationId: string) => active.has(conversationId)
      ? { conversationId, ...active.get(conversationId)!, release: vi.fn() } : null,
    steer: async (
      lease: { turnId: string; runId: string },
      input: { content: string },
      attachments: unknown,
      acknowledged?: () => void,
    ) => await steerHandler(lease, input, attachments, acknowledged),
    setSteerHandler: (next: typeof steerHandler) => { steerHandler = next; },
    failCleanupOnce: (error: Error) => { failNextCleanup = error; },
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
  const { conversationId: childId, turnId: firstTurnId } = JSON.parse(created.text) as { conversationId: string; turnId: string };
  return { store, db, project, source, sourceTurn, bridge, childId, firstTurnId, turns, messageQueue, toolCall };
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

  it("S2: mode restart commits stop+enqueue atomically and records exactly one queue.item-delivered with real V2 turn admission", async () => {
    const env = await setup({ orchestrated: true });
    try {
      const priorItem = env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: "Earlier queued work",
        createdBy: "agent",
        creationSource: "mcp",
      }).value.id;

      const restartCall = env.toolCall("inertia_send_message", {
        conversationId: env.childId,
        content: "Fresh replacement prompt",
        mode: "restart",
      });
      const res = await env.bridge.invoke(restartCall);
      expect(res.success).toBe(true);
      const parsed = JSON.parse(res.text) as {
        conversationId: string;
        turnId: string;
        queuedMessageId: string;
        disposition: string;
        accepted: boolean;
        stoppedTurnId: string;
      };
      expect(parsed).toMatchObject({
        conversationId: env.childId,
        disposition: "restarted",
        accepted: true,
        stoppedTurnId: env.firstTurnId,
      });
      expect(env.turns.activeIdentity(env.childId)?.turnId).toBe(parsed.turnId);
      expect(env.store.orchestration.queue.getItem(parsed.queuedMessageId)?.state).toBe("delivered");
      expect(env.store.orchestration.queue.getItem(priorItem)?.queueHeld).toBe(true);

      const events = env.db.prepare(`
        SELECT type, command_id AS commandId, payload_json AS payloadJson
        FROM orchestration_v2_events WHERE thread_id = ? ORDER BY sequence ASC
      `).all(env.childId) as Array<{ type: string; commandId: string; payloadJson: string }>;

      const interruptEvent = events.find((event) => event.type === "run-control.interrupt-recorded");
      const enqueueEvent = events.find(
        (event) => event.type === "queue.item-enqueued" && event.payloadJson.includes(parsed.queuedMessageId),
      );
      expect(interruptEvent).toBeDefined();
      expect(enqueueEvent).toBeDefined();
      // Atomic stop + enqueue: both events belong to the exact same command transaction.
      expect(enqueueEvent!.commandId).toBe(interruptEvent!.commandId);

      const deliveredEvents = events.filter(
        (event) => event.type === "queue.item-delivered" && event.payloadJson.includes(parsed.queuedMessageId),
      );
      expect(deliveredEvents).toHaveLength(1);
    } finally {
      env.store.close();
    }
  });

  it("S2: mode restart preserves the position-1 unheld replacement item if crash/failure occurs after atomic stop+enqueue", async () => {
    const env = await setup({ orchestrated: true });
    try {
      env.turns.failCleanupOnce(new Error("Simulated crash during cleanup wait"));
      const res = await env.bridge.invoke(env.toolCall("inertia_send_message", {
        conversationId: env.childId,
        content: "Survives post-stop crash",
        mode: "restart",
      }));
      expect(res.success).toBe(false);
      // Turn was stopped, and the replacement prompt is durably queued at position 1 unheld.
      expect(env.turns.isActive(env.childId)).toBe(false);
      const activeItems = env.store.orchestration.queue.listActive(env.childId);
      expect(activeItems).toHaveLength(1);
      expect(activeItems[0]).toMatchObject({
        state: "waiting",
        queuePosition: 1,
        queueHeld: false,
        createdBy: "agent",
        creationSource: "mcp",
      });
      expect(env.store.orchestration.queue.getContent(env.childId, activeItems[0]!.id)?.content).toBe("Survives post-stop crash");
    } finally {
      env.store.close();
    }
  });

  it("S7: enforces accessMode and interactionMode ceilings on send and inertia_queue including active turns and approval-window drift", async () => {
    const env = await setup({ orchestrated: true });
    try {
      const itemA = env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: "Queued A",
        createdBy: "agent",
        creationSource: "mcp",
      }).value.id;
      const itemB = env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: "Queued B",
        createdBy: "agent",
        creationSource: "mcp",
      }).value.id;

      // (a) Child widened to full access while parent is supervised -> every send mode rejected on active turn.
      env.store.updateConversation(env.childId, { accessMode: "full" });
      for (const mode of ["auto", "steer", "queue", "restart"] as const) {
        const sendCall = env.toolCall("inertia_send_message", {
          conversationId: env.childId,
          content: `Try ${mode}`,
          mode,
        });
        const res = await env.bridge.invoke(sendCall);
        expect(res.success).toBe(false);
        expect(JSON.parse(res.text).error.code).toBe("access_mode_escalation_denied");
        expect(sendCall.requestApproval).not.toHaveBeenCalled();
      }

      // Restore accessMode, lower caller interactionMode to plan while child is build -> every send & queue mutation rejected.
      env.store.updateConversation(env.childId, { accessMode: "supervised" });
      env.store.updateConversation(env.source.id, { interactionMode: "plan" });
      for (const mode of ["auto", "steer", "queue", "restart"] as const) {
        const sendCall = env.toolCall("inertia_send_message", {
          conversationId: env.childId,
          content: `Plan caller ${mode}`,
          mode,
        });
        const res = await env.bridge.invoke(sendCall);
        expect(res.success).toBe(false);
        expect(JSON.parse(res.text).error.code).toBe("interaction_mode_escalation_denied");
        expect(sendCall.requestApproval).not.toHaveBeenCalled();
      }
      for (const args of [
        { conversationId: env.childId, action: "edit", itemId: itemA, content: "Nope" },
        { conversationId: env.childId, action: "reorder", itemId: itemB, beforeItemId: itemA },
        { conversationId: env.childId, action: "promote_to_steer", itemId: itemA },
        { conversationId: env.childId, action: "cancel", itemId: itemA },
      ]) {
        const queueCall = env.toolCall("inertia_queue", args);
        const res = await env.bridge.invoke(queueCall);
        expect(res.success).toBe(false);
        expect(JSON.parse(res.text).error.code).toBe("interaction_mode_escalation_denied");
        expect(queueCall.requestApproval).not.toHaveBeenCalled();
      }

      // (b) Target widened or caller lowered DURING approval wait -> rejected when re-checked immediately before dispatch/mutation.
      env.store.updateConversation(env.source.id, { interactionMode: "build", accessMode: "supervised" });
      const sendDriftCall = env.toolCall("inertia_send_message", {
        conversationId: env.childId,
        content: "Drift send",
        mode: "steer",
      });
      sendDriftCall.requestApproval = vi.fn(async () => {
        env.store.updateConversation(env.childId, { accessMode: "full" });
        return "approve" as const;
      });
      const sendDriftRes = await env.bridge.invoke(sendDriftCall);
      expect(sendDriftRes.success).toBe(false);
      expect(JSON.parse(sendDriftRes.text).error.code).toBe("access_mode_escalation_denied");
      expect(sendDriftCall.requestApproval).toHaveBeenCalledOnce();

      env.store.updateConversation(env.childId, { accessMode: "supervised" });
      const queueDriftCall = env.toolCall("inertia_queue", {
        conversationId: env.childId,
        action: "edit",
        itemId: itemA,
        content: "Drift edit",
      });
      queueDriftCall.requestApproval = vi.fn(async () => {
        env.store.updateConversation(env.source.id, { interactionMode: "plan" });
        return "approve" as const;
      });
      const queueDriftRes = await env.bridge.invoke(queueDriftCall);
      expect(queueDriftRes.success).toBe(false);
      expect(JSON.parse(queueDriftRes.text).error.code).toBe("interaction_mode_escalation_denied");
      expect(queueDriftCall.requestApproval).toHaveBeenCalledOnce();
      expect(env.store.orchestration.queue.getContent(env.childId, itemA)?.content).toBe("Queued A");
    } finally {
      env.store.close();
    }
  });

  it("S8: promote_to_steer records durable provider.steer effect and settles/releases/blocks cleanly on every error path", async () => {
    const env = await setup({ orchestrated: true });
    try {
      const okItem = env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: "Promote ok",
        createdBy: "agent",
        creationSource: "mcp",
      }).value.id;
      const okRes = await env.bridge.invoke(env.toolCall("inertia_queue", {
        conversationId: env.childId,
        action: "promote_to_steer",
        itemId: okItem,
      }));
      expect(okRes.success).toBe(true);
      const deliveredItem = env.store.orchestration.queue.getItem(okItem);
      expect(deliveredItem?.state).toBe("delivered");
      expect(deliveredItem?.delivery?.steerEffectId).toMatch(/^steer:/u);
      const steerEffect = env.store.orchestration.runControl.steer(deliveredItem!.delivery!.steerEffectId!);
      expect(steerEffect).toMatchObject({ state: "settled", outcome: "accepted", queuedMessageId: okItem });

      // Non-ambiguous thrown error -> settles steer effect as unavailable and releases claim back to waiting (never stuck dispatching).
      const retryItem = env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: "Promote transient throw",
        createdBy: "agent",
        creationSource: "mcp",
      }).value.id;
      env.turns.setSteerHandler(async () => {
        throw new Error("Transient provider pipe error");
      });
      const throwRes = await env.bridge.invoke(env.toolCall("inertia_queue", {
        conversationId: env.childId,
        action: "promote_to_steer",
        itemId: retryItem,
      }));
      expect(throwRes.success).toBe(false);
      expect(env.store.orchestration.queue.getItem(retryItem)?.state).toBe("waiting");
      expect(env.messageQueue.schedule).toHaveBeenCalledWith(env.childId);

      // Ambiguous thrown error -> settles steer effect as unconfirmed and blocks item as steer-unconfirmed (never double-sent).
      const ambigItem = env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: "Promote ambiguous throw",
        createdBy: "agent",
        creationSource: "mcp",
      }).value.id;
      env.turns.setSteerHandler(async () => {
        throw new RuntimeRequestError("Provider dropped connection after steer dispatch", undefined, "ambiguous");
      });
      const ambigRes = await env.bridge.invoke(env.toolCall("inertia_queue", {
        conversationId: env.childId,
        action: "promote_to_steer",
        itemId: ambigItem,
      }));
      expect(ambigRes.success).toBe(false);
      expect(env.store.orchestration.queue.getItem(ambigItem)).toMatchObject({
        state: "blocked",
        blockedReason: "steer-unconfirmed",
      });

      const steerEffects = env.db.prepare(`
        SELECT payload_json AS payloadJson FROM orchestration_v2_entities
        WHERE kind = 'run-steer' AND thread_id = ?
      `).all(env.childId) as Array<{ payloadJson: string }>;
      const outcomes = steerEffects.map((row) => (JSON.parse(row.payloadJson) as { outcome: string }).outcome).sort();
      expect(outcomes).toEqual(["accepted", "unavailable", "unconfirmed"]);
    } finally {
      env.store.close();
    }
  });

  it("S9 (N17): edit and reorder return text-free metadata and persist zero queue text in operation journals, events, or receipts", async () => {
    const env = await setup({ orchestrated: true });
    try {
      const secretMarkerA = "CONFIDENTIAL_QUEUE_TEXT_ALPHA_918273";
      const secretMarkerB = "CONFIDENTIAL_QUEUE_TEXT_BETA_445566";
      const editedMarker = "CONFIDENTIAL_EDITED_TEXT_GAMMA_778899";

      const itemA = env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: secretMarkerA,
        createdBy: "agent",
        creationSource: "mcp",
      }).value.id;
      const itemB = env.store.orchestration.queue.enqueue({
        conversationId: env.childId,
        itemId: crypto.randomUUID(),
        content: secretMarkerB,
        createdBy: "agent",
        creationSource: "mcp",
      }).value.id;

      const editRes = await env.bridge.invoke(env.toolCall("inertia_queue", {
        conversationId: env.childId,
        action: "edit",
        itemId: itemA,
        content: editedMarker,
        expectedRevision: 0,
      }));
      expect(editRes.success).toBe(true);
      const editParsed = JSON.parse(editRes.text) as { item: Record<string, unknown> };
      expect(editParsed.item).toMatchObject({
        itemId: itemA,
        kind: "message",
        state: "waiting",
        queuePosition: 1,
        queueHeld: false,
        editRevision: 1,
        attachmentCount: 0,
        chars: editedMarker.length,
      });
      expect(editParsed.item).not.toHaveProperty("preview");
      expect(editParsed.item).not.toHaveProperty("content");
      expect(editRes.text).not.toContain(editedMarker);
      expect(editRes.text).not.toContain(secretMarkerA);

      const reorderRes = await env.bridge.invoke(env.toolCall("inertia_queue", {
        conversationId: env.childId,
        action: "reorder",
        itemId: itemB,
        beforeItemId: itemA,
      }));
      expect(reorderRes.success).toBe(true);
      const reorderParsed = JSON.parse(reorderRes.text) as { items: Array<Record<string, unknown>> };
      expect(reorderParsed.items.map((item) => item.itemId)).toEqual([itemB, itemA]);
      for (const item of reorderParsed.items) {
        expect(item).not.toHaveProperty("preview");
        expect(item).not.toHaveProperty("content");
        expect(typeof item.queuePosition).toBe("number");
      }
      expect(reorderRes.text).not.toContain(editedMarker);
      expect(reorderRes.text).not.toContain(secretMarkerB);

      // Verify read-only list/read still serve live preview/content from queued_messages.
      const listRes = await env.bridge.invoke(env.toolCall("inertia_queue", { conversationId: env.childId, action: "list" }));
      expect(listRes.text).toContain(editedMarker);
      expect(listRes.text).toContain(secretMarkerB);

      // Verify zero queue text leaked into agent_thread_operations, orchestration_v2_events, or orchestration_v2_receipts.
      const opRows = env.db.prepare("SELECT result_json AS resultJson, failure_message AS failureMessage FROM agent_thread_operations").all();
      const eventRows = env.db.prepare("SELECT payload_json AS payloadJson FROM orchestration_v2_events WHERE thread_id = ?").all(env.childId);
      const receiptRows = env.db.prepare("SELECT result_json AS resultJson FROM orchestration_v2_receipts WHERE thread_id = ?").all(env.childId);
      const persistedDump = JSON.stringify({ opRows, eventRows, receiptRows });
      for (const marker of [secretMarkerA, secretMarkerB, editedMarker]) {
        expect(persistedDump).not.toContain(marker);
      }
    } finally {
      env.store.close();
    }
  });
});
