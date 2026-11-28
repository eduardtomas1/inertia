import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  ModelSelection,
  ProviderId,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
  nativeModelSelection,
  providerNativeBackendProfile,
  resolveHarnessBackendCompatibility,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { isItemCovered } from "../../src/server/orchestration-v2/backing-repository";
import type {
  ProviderBackgroundWork,
  ProviderBackgroundWorkSession,
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
  ProviderSteerInput,
} from "../../src/server/provider/contracts";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import { bindSteerEffectId } from "../../src/server/runtime/turns/turn-follow-up-coordinator";
import { adoptSettledUnreadFollowUps } from "../../src/server/runtime/queued-message-operations";
import { reconcileQueueOnBoot } from "../../src/server/runtime/queue-boot-reconciliation";
import {
  ContextHandoffBackgroundWorkError,
  ProviderSwitchBackgroundWorkError,
  QueuedSelectionProviderUnavailableError,
} from "../../src/server/runtime/turns/turn-request-preparation";

const temporaryDirectories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeProviderInfo(overrides: Partial<Record<"codex" | "claude", Partial<ProviderInfo>>> = {}): ProviderInfo[] {
  const codex: ProviderInfo = {
    id: "codex",
    name: "Codex",
    command: "codex",
    available: true,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    cleanupConfirmed: true,
    models: [
      { id: "gpt-5", label: "GPT-5", isDefault: true, inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high" },
    ],
    ...overrides.codex,
  } as ProviderInfo;
  const claude: ProviderInfo = {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    available: true,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    cleanupConfirmed: true,
    models: [
      { id: "claude-sonnet-4", label: "Claude Sonnet 4", isDefault: true, inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
    ],
    ...overrides.claude,
  } as ProviderInfo;
  return [codex, claude];
}

function createHarness(options: {
  initialProviderId?: ProviderId;
  providerInfo?: () => ProviderInfo[];
  onSteer?: (
    input: ProviderSteerInput,
    callbacks: ProviderRunCallbacks | null,
  ) => Promise<boolean>;
  pendingBackgroundWork?: (session: ProviderBackgroundWorkSession) => ProviderBackgroundWork;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "inertia-steer-read-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
    recoverInterruptedRuns: false,
  });
  stores.push(store);
  const project = store.createProject("Steer Read Mapping", workspace);
  const codexSelection = modelSelectionSchema.parse(nativeModelSelection({
    providerId: "codex",
    modelId: "gpt-5",
    reasoningEffort: "high",
  }));
  const claudeSelection = modelSelectionSchema.parse(nativeModelSelection({
    providerId: "claude",
    modelId: "claude-sonnet-4",
    reasoningEffort: "medium",
  }));
  const initialProviderId = options.initialProviderId ?? "claude";
  const conversation = store.createConversation(project.id, "Claude Thread", {
    providerId: initialProviderId,
    modelSelection: initialProviderId === "claude" ? claudeSelection : codexSelection,
  });

  let runningConversation: string | null = null;
  let capturedCallbacks: ProviderRunCallbacks | null = null;
  let capturedInput: ProviderRunInput | null = null;
  let resolveRun: ((result: ProviderRunResult) => void) | null = null;

  const runtime: TurnProviderRuntime & {
    pendingBackgroundWork?: (session: ProviderBackgroundWorkSession) => ProviderBackgroundWork;
  } = {
    resolveModelRoute(selection: ModelSelection) {
      const providerId = selection.harnessId === "claude-agent-sdk" ? "claude" : "codex";
      const harnessId = selection.harnessId as "codex-app-server" | "claude-agent-sdk";
      const backendProfile = providerNativeBackendProfile(providerId);
      return {
        providerId,
        harnessId,
        backendProfile,
        compatibility: resolveHarnessBackendCompatibility(harnessId, backendProfile),
        continuationIdentity: continuationIdentityForSelection(selection, null, false),
      };
    },
    harnessIdFor: (input) => input.harnessId,
    providerCapabilityAvailable: () => true,
    async run(input, callbacks) {
      runningConversation = input.conversationId;
      capturedCallbacks = callbacks;
      capturedInput = input;
      callbacks.onStarted?.();
      try {
        return await new Promise<ProviderRunResult>((resolve) => {
          resolveRun = resolve;
        });
      } finally {
        if (runningConversation === input.conversationId) runningConversation = null;
      }
    },
    async steer(_conversationId, input) {
      if (options.onSteer) {
        return await options.onSteer(input, capturedCallbacks);
      }
      return true;
    },
    cancel: () => true,
    stopOwned: async () => "settled",
    isRunning: (conversationId) => runningConversation === conversationId,
    ownsRun: () => false,
    respondToApproval: () => false,
    respondToInput: () => false,
    disposeAll: async () => undefined,
    ...(options.pendingBackgroundWork ? { pendingBackgroundWork: options.pendingBackgroundWork } : {}),
  };

  const controller = new TurnController(
    store,
    runtime,
    new Map<string, AgentApprovalRequest>(),
    new Map<string, AgentInputRequest>(),
    new Map<string, AgentPlan>(),
    {
      broadcast: vi.fn(),
      broadcastSnapshot: vi.fn(),
      providerInfo: options.providerInfo ?? (() => makeProviderInfo()),
    },
  );

  async function requestDurableSteer(runId: string, turnId: string): Promise<string> {
    let effectId = "";
    const start = await store.orchestration.authority.begin({
      source: { actorId: "human", commandId: `steer-cmd-${randomUUID()}`, command: { type: "message.follow-up" } },
      threadId: conversation.id,
      projectId: conversation.projectId,
      commandType: "message.follow-up",
      rejection: null,
    }, (ticket) => {
      const req = store.orchestration.runControl.requestSteer(ticket, runId, turnId);
      if (req.kind !== "requested") throw new Error(`Expected requested steer, got ${req.kind}`);
      effectId = req.effectId;
    });
    if (start.kind !== "lead") throw new Error(`Expected lead command, got ${start.kind}`);
    start.ticket.finish(null);
    return effectId;
  }

  async function completeActiveTurn(sessionId: string): Promise<void> {
    if (!capturedInput || !resolveRun) throw new Error("No active provider run");
    capturedCallbacks?.onEvent?.({
      type: "session",
      providerId: capturedInput.providerId,
      conversationId: conversation.id,
      runId: capturedInput.runId,
      turnId: capturedInput.turnId,
      sessionId,
    });
    resolveRun({
      providerId: capturedInput.providerId,
      conversationId: conversation.id,
      runId: capturedInput.runId,
      turnId: capturedInput.turnId,
      status: "completed",
      terminalReason: { outcome: "completed", reason: "provider-completed" },
      sessionId,
      text: "Done",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });
    await vi.waitFor(() => expect(store.agentTurn(capturedInput!.turnId).status).toBe("completed"));
    await controller.drainSettlementTasks();
  }

  return {
    store,
    conversation,
    codexSelection,
    claudeSelection,
    controller,
    runtime,
    getCallbacks: () => capturedCallbacks,
    getInput: () => capturedInput,
    requestDurableSteer,
    completeActiveTurn,
  };
}

describe("S4: steerId -> effectId mapping and early onSteerRead preservation", () => {
  it("maps provider steerId to durable effectId on normal onSteerRead, records steer-read, and covers without requeuing", async () => {
    let observedSteerId: string | undefined;
    const harness = createHarness({
      onSteer: async (input) => {
        observedSteerId = input.steerId;
        return true;
      },
    });
    const { store, conversation, controller } = harness;

    const queued = controller.queue({ conversationId: conversation.id, content: "Start Claude turn" });
    expect(controller.start(queued.turn.id)).toBe(true);
    await vi.waitFor(() => expect(harness.getCallbacks()).not.toBeNull());
    // Transition turn to running so follow-up admission is ready immediately.
    harness.getCallbacks()!.onEvent?.({
      type: "status",
      providerId: "claude",
      conversationId: conversation.id,
      runId: queued.turn.runId,
      turnId: queued.turn.id,
      status: "running",
    });

    const lease = controller.acquireFollowUpAdmission(conversation.id);
    expect(lease).not.toBeNull();
    const effectId = await harness.requestDurableSteer(queued.turn.runId, queued.turn.id);
    bindSteerEffectId(lease!, effectId);

    const steered = await controller.steer(lease!, { content: "Follow-up read normally", imagePaths: [] });
    lease!.release();
    expect(steered.kind).toBe("accepted");
    if (steered.kind !== "accepted") throw new Error("expected accepted");
    expect(observedSteerId).toBeTruthy();
    expect(observedSteerId).not.toBe(effectId);

    store.orchestration.runControl.settleSteer(effectId, "accepted", { messageId: steered.message.id });
    expect(store.orchestration.runControl.listUnreadAcceptedSteers(queued.turn.runId)).toHaveLength(1);

    const readAt = "2026-11-27T05:10:00.000Z";
    harness.getCallbacks()!.onSteerRead?.(observedSteerId!, readAt);

    expect(store.orchestration.runControl.steer(effectId)?.readAt).toBe(readAt);
    expect(store.orchestration.runControl.listUnreadAcceptedSteers(queued.turn.runId)).toEqual([]);

    await harness.completeActiveTurn("claude-sess-normal");

    // Read follow-up must NOT be requeued on normal completion and MUST be covered by the backing.
    expect(store.queuedMessages.list(conversation.id)).toEqual([]);
    expect(store.orchestration.queue.listActive(conversation.id)).toEqual([]);
    const backing = store.orchestration.backings.find({
      threadId: conversation.id,
      providerId: "claude",
      workspaceKey: store.conversationPath(conversation.id),
      identity: queued.turn.continuationIdentity,
      nativeSessionId: "claude-sess-normal",
    });
    expect(backing).not.toBeNull();
    expect(isItemCovered(backing!, steered.message.id, 1)).toBe(true);
  });

  it("preserves early onSteerRead arriving before providers.steer resolves and records steer-read once durable acceptance commits", async () => {
    const earlyReadAt = "2026-11-27T05:11:00.000Z";
    let observedSteerId: string | undefined;
    let releaseProviderSteer!: (accepted: boolean) => void;
    const harness = createHarness({
      onSteer: async (input, callbacks) => {
        observedSteerId = input.steerId;
        // Provider invokes onSteerRead synchronously BEFORE providers.steer resolves and BEFORE settleSteer commits!
        callbacks?.onSteerRead?.(input.steerId!, earlyReadAt);
        return await new Promise<boolean>((resolve) => {
          releaseProviderSteer = resolve;
        });
      },
    });
    const { store, conversation, controller } = harness;

    const queued = controller.queue({ conversationId: conversation.id, content: "Start Claude turn" });
    expect(controller.start(queued.turn.id)).toBe(true);
    await vi.waitFor(() => expect(harness.getCallbacks()).not.toBeNull());
    harness.getCallbacks()!.onEvent?.({
      type: "status",
      providerId: "claude",
      conversationId: conversation.id,
      runId: queued.turn.runId,
      turnId: queued.turn.id,
      status: "running",
    });

    const lease = controller.acquireFollowUpAdmission(conversation.id);
    expect(lease).not.toBeNull();
    const effectId = await harness.requestDurableSteer(queued.turn.runId, queued.turn.id);
    bindSteerEffectId(lease!, effectId);

    const steerPromise = controller.steer(lease!, { content: "Follow-up read early", imagePaths: [] });
    await vi.waitFor(() => expect(observedSteerId).toBeTruthy());

    // Acceptance has not committed yet, so durable steer projection is still dispatching with readAt = null.
    expect(store.orchestration.runControl.steer(effectId)).toMatchObject({
      state: "dispatching",
      outcome: null,
      readAt: null,
    });

    releaseProviderSteer(true);
    const steered = await steerPromise;
    lease!.release();
    expect(steered.kind).toBe("accepted");
    if (steered.kind !== "accepted") throw new Error("expected accepted");

    // Still dispatching until durable acceptance commits.
    expect(store.orchestration.runControl.steer(effectId)).toMatchObject({
      state: "dispatching",
      readAt: null,
    });

    // Once durable acceptance commits, the preserved early read flushes immediately.
    store.orchestration.runControl.settleSteer(effectId, "accepted", { messageId: steered.message.id });
    expect(store.orchestration.runControl.steer(effectId)).toMatchObject({
      state: "settled",
      outcome: "accepted",
      readAt: earlyReadAt,
    });
    expect(store.orchestration.runControl.listUnreadAcceptedSteers(queued.turn.runId)).toEqual([]);

    await harness.completeActiveTurn("claude-sess-early");

    // Must NOT be requeued on normal completion and MUST be covered by backing.
    expect(store.queuedMessages.list(conversation.id)).toEqual([]);
    expect(store.orchestration.queue.listActive(conversation.id)).toEqual([]);
    const backing = store.orchestration.backings.find({
      threadId: conversation.id,
      providerId: "claude",
      workspaceKey: store.conversationPath(conversation.id),
      identity: queued.turn.continuationIdentity,
      nativeSessionId: "claude-sess-early",
    });
    expect(backing).not.toBeNull();
    expect(isItemCovered(backing!, steered.message.id, 1)).toBe(true);
  });

  it("discards a buffered early onSteerRead when the steer is refused", async () => {
    const harness = createHarness({
      onSteer: async (input, callbacks) => {
        callbacks?.onSteerRead?.(input.steerId!, "2026-11-27T05:12:00.000Z");
        return false;
      },
    });
    const { store, conversation, controller } = harness;

    const queued = controller.queue({ conversationId: conversation.id, content: "Start Claude turn" });
    expect(controller.start(queued.turn.id)).toBe(true);
    await vi.waitFor(() => expect(harness.getCallbacks()).not.toBeNull());
    harness.getCallbacks()!.onEvent?.({
      type: "status",
      providerId: "claude",
      conversationId: conversation.id,
      runId: queued.turn.runId,
      turnId: queued.turn.id,
      status: "running",
    });

    const lease = controller.acquireFollowUpAdmission(conversation.id)!;
    const effectId = await harness.requestDurableSteer(queued.turn.runId, queued.turn.id);
    bindSteerEffectId(lease, effectId);

    const steered = await controller.steer(lease, { content: "Refused follow-up", imagePaths: [] });
    lease.release();
    expect(steered.kind).toBe("refused");

    store.orchestration.runControl.settleSteer(effectId, "refused", { messageId: null });
    expect(store.orchestration.runControl.steer(effectId)).toMatchObject({
      state: "settled",
      outcome: "refused",
      readAt: null,
    });
  });

  it("requeues an accepted Claude follow-up whose onSteerRead never fires before normal completion", async () => {
    const harness = createHarness({
      onSteer: async () => true,
    });
    const { store, conversation, controller } = harness;

    const queued = controller.queue({ conversationId: conversation.id, content: "Start Claude turn" });
    expect(controller.start(queued.turn.id)).toBe(true);
    await vi.waitFor(() => expect(harness.getCallbacks()).not.toBeNull());
    harness.getCallbacks()!.onEvent?.({
      type: "status",
      providerId: "claude",
      conversationId: conversation.id,
      runId: queued.turn.runId,
      turnId: queued.turn.id,
      status: "running",
    });

    const lease = controller.acquireFollowUpAdmission(conversation.id)!;
    const effectId = await harness.requestDurableSteer(queued.turn.runId, queued.turn.id);
    bindSteerEffectId(lease, effectId);

    const steered = await controller.steer(lease, { content: "Unread follow-up", imagePaths: [] });
    lease.release();
    expect(steered.kind).toBe("accepted");
    if (steered.kind !== "accepted") throw new Error("expected accepted");

    store.orchestration.runControl.settleSteer(effectId, "accepted", { messageId: steered.message.id });
    expect(store.orchestration.runControl.listUnreadAcceptedSteers(queued.turn.runId)).toHaveLength(1);

    await harness.completeActiveTurn("claude-sess-unread");

    // Unread follow-up MUST be requeued by reference on normal completion.
    const requeued = store.queuedMessages.list(conversation.id);
    expect(requeued.some((entry) => entry.userMessageId === steered.message.id)).toBe(true);
  });

  async function interruptedWithUnreadFollowUp() {
    const harness = createHarness({ onSteer: async () => true });
    const { store, conversation, controller } = harness;
    const queued = controller.queue({ conversationId: conversation.id, content: "Start Claude turn" });
    expect(controller.start(queued.turn.id)).toBe(true);
    await vi.waitFor(() => expect(harness.getCallbacks()).not.toBeNull());
    harness.getCallbacks()!.onEvent?.({ type: "status", providerId: "claude", conversationId: conversation.id,
      runId: queued.turn.runId, turnId: queued.turn.id, status: "running" });
    const lease = controller.acquireFollowUpAdmission(conversation.id)!;
    const effectId = await harness.requestDurableSteer(queued.turn.runId, queued.turn.id);
    bindSteerEffectId(lease, effectId);
    const steered = await controller.steer(lease, { content: "Unread follow-up", imagePaths: [] });
    lease.release();
    if (steered.kind !== "accepted") throw new Error("expected accepted");
    store.orchestration.runControl.settleSteer(effectId, "accepted", { messageId: steered.message.id });
    await harness.completeActiveTurn("claude-sess-removed");
    const database = (store as unknown as { database: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).database;
    return { store, conversation, turn: queued.turn, message: steered.message,
      interrupt: () => database.prepare("UPDATE agent_turns SET status = 'interrupted' WHERE id = ?").run(queued.turn.id),
      dropQueueRow: () => database.prepare("DELETE FROM queued_messages WHERE user_message_id = ?").run(steered.message.id) };
  }

  it("requeues an interrupted run's unread follow-up at boot, held", async () => {
    const { store, conversation, message, interrupt, dropQueueRow } = await interruptedWithUnreadFollowUp();
    dropQueueRow();
    interrupt();
    const report = await reconcileQueueOnBoot(store);
    expect(report.requeuedUnreadSteers).toHaveLength(1);
    expect(store.orchestration.queue.listActive(conversation.id).find((item) => item.userMessageId === message.id))
      .toMatchObject({ id: report.requeuedUnreadSteers[0], state: "waiting", queueHeld: true });
  });

  it("boots without requeueing an unread follow-up the user removed after settlement requeued it", async () => {
    const { store, conversation, turn, message, interrupt } = await interruptedWithUnreadFollowUp();
    expect(adoptSettledUnreadFollowUps(store, store.agentTurn(turn.id))).toBe(true);
    const requeued = store.orchestration.queue.listActive(conversation.id)
      .find((item) => item.userMessageId === message.id)!;
    store.orchestration.queue.cancel({ conversationId: conversation.id, itemId: requeued.id, reason: "user" });
    interrupt();

    const report = await reconcileQueueOnBoot(store);
    expect(report.requeuedUnreadSteers).toEqual([]);
    expect(store.orchestration.queue.listActive(conversation.id).some((item) => item.userMessageId === message.id))
      .toBe(false);
    await expect(reconcileQueueOnBoot(store)).resolves.toMatchObject({ requeuedUnreadSteers: [] });
  });
});

describe("S1: TurnController.queue modelSelectionOverride plumbing and H6 busy-session detection", () => {
  it("forwards modelSelectionOverride through TurnController.queue to providerInput without mutating live conversation selection", async () => {
    const harness = createHarness({ initialProviderId: "codex" });
    const { store, conversation, claudeSelection, controller } = harness;

    // Seed a completed Codex turn so live conversation has a Codex session and backing.
    const t1 = controller.queue({ conversationId: conversation.id, content: "Codex baseline" });
    expect(controller.start(t1.turn.id)).toBe(true);
    await vi.waitFor(() => expect(harness.getInput()).not.toBeNull());
    await harness.completeActiveTurn("codex-live-sess");
    expect(store.conversation(conversation.id).providerSessionId).toBe("codex-live-sess");

    // Enqueue a V2 item with explicit Claude selection so persistence permits cross-provider turn admission.
    const itemId = randomUUID();
    store.orchestration.queue.enqueue({
      conversationId: conversation.id,
      itemId,
      content: "Queued item on Claude",
      attachments: [],
      kind: "message",
      createdBy: "user",
      creationSource: "web",
      routeIdentity: "",
      modelSelection: claudeSelection,
      origin: "command",
    });
    store.orchestration.queue.claim({ conversationId: conversation.id, itemId, mode: "run" });

    const t2 = controller.queue({
      conversationId: conversation.id,
      queuedMessageId: itemId,
      content: "Queued item on Claude",
      modelSelectionOverride: claudeSelection,
    });
    expect(t2.turn.providerId).toBe("claude");
    expect(t2.turn.modelSelection.modelId).toBe("claude-sonnet-4");
    expect(t2.turn.providerSessionBefore).toBeNull();

    expect(controller.start(t2.turn.id)).toBe(true);
    await vi.waitFor(() => expect(harness.getInput()?.turnId).toBe(t2.turn.id));
    expect(harness.getInput()).toMatchObject({
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      model: "claude-sonnet-4",
      sessionId: undefined,
    });

    await harness.completeActiveTurn("claude-override-sess");
    // Live conversation still belongs to Codex and kept its Codex session pointer intact.
    expect(store.conversation(conversation.id).providerId).toBe("codex");
    expect(store.conversation(conversation.id).providerSessionId).toBe("codex-live-sess");
  });

  it("throws QueuedSelectionProviderUnavailableError when modelSelectionOverride targets a disabled provider", () => {
    const harness = createHarness({
      initialProviderId: "codex",
      providerInfo: () => makeProviderInfo({ claude: { canRun: false, statusMessage: "Claude is disabled." } }),
    });
    const { conversation, claudeSelection, controller } = harness;

    expect(() => controller.queue({
      conversationId: conversation.id,
      content: "Blocked on disabled Claude",
      modelSelectionOverride: claudeSelection,
    })).toThrowError(QueuedSelectionProviderUnavailableError);
  });

  it("throws ProviderSwitchBackgroundWorkError (instanceof ContextHandoffBackgroundWorkError) when modelSelectionOverride switches away from a busy session (H6)", async () => {
    const probedSessions: ProviderBackgroundWorkSession[] = [];
    let backgroundWork: ProviderBackgroundWork = "none";
    const harness = createHarness({
      initialProviderId: "codex",
      pendingBackgroundWork: (session) => {
        probedSessions.push(session);
        return backgroundWork;
      },
    });
    const { store, conversation, claudeSelection, controller } = harness;

    const t1 = controller.queue({ conversationId: conversation.id, content: "Codex turn 1" });
    expect(controller.start(t1.turn.id)).toBe(true);
    await vi.waitFor(() => expect(harness.getInput()).not.toBeNull());
    await harness.completeActiveTurn("codex-busy-sess");

    backgroundWork = "pending";
    let caught: unknown = null;
    try {
      controller.queue({
        conversationId: conversation.id,
        content: "Switch to Claude while Codex has background work",
        modelSelectionOverride: claudeSelection,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderSwitchBackgroundWorkError);
    expect(caught).toBeInstanceOf(ContextHandoffBackgroundWorkError);
    expect(probedSessions).toEqual([{
      conversationId: conversation.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      nativeSessionId: "codex-busy-sess",
    }]);
    // No second turn was persisted while the replaced session was busy.
    expect(store.agentTurnsForConversation(conversation.id)).toHaveLength(1);
  });
});
