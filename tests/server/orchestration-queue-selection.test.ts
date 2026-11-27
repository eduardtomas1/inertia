import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  ClientCommand,
  ModelSelection,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
  nativeModelSelection,
  providerNativeBackendProfile,
  resolveHarnessBackendCompatibility,
} from "../../src/shared/model-routing";
import type { UsageAccount } from "../../src/shared/provider-usage-limits";
import { RuntimeStore } from "../../src/server/database";
import type {
  ProviderEvent,
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import {
  CheckoutMoveBackgroundWorkError,
  ContextHandoffBackgroundWorkError,
  QueuedSelectionProviderUnavailableError,
  resolveTurnRequest,
} from "../../src/server/runtime/turns/turn-request-preparation";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import type WebSocket from "ws";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import { computeQueueHoldReason, usageLimitHoldsQueue } from "../../src/server/runtime/queued-message-runtime-helpers";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { LimitResetScheduler } from "../../src/server/usage/limit-reset-scheduler";
import { isItemCovered } from "../../src/server/orchestration-v2/backing-repository";
import { providerInstanceId } from "../../src/server/orchestration-v2/provider-instance";

const temporaryDirectories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createEnv() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-queue-selection-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
    recoverInterruptedRuns: false,
  });
  stores.push(store);
  const project = store.createProject("Queue Selection", workspace);
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
  const conversation = store.createConversation(project.id, "Active Thread", {
    providerId: "codex",
    modelSelection: codexSelection,
  });
  return { directory, workspace, store, project, conversation, codexSelection, claudeSelection };
}

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
      { id: "gpt-5.4", label: "GPT-5.4", isDefault: false, inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
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
      { id: "claude-opus-4", label: "Claude Opus 4", isDefault: false, inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high" },
    ],
    ...overrides.claude,
  } as ProviderInfo;
  return [codex, claude];
}

function makeProviderRuntime(options: {
  resolveError?: (selection: ModelSelection) => Error | null;
  pendingBackgroundWork?: () => "none" | "pending";
  onRun?: (input: ProviderRunInput, callbacks: ProviderRunCallbacks) => Promise<ProviderRunResult>;
} = {}) {
  let runningConversation: string | null = null;
  let lastCallbacks: ProviderRunCallbacks | null = null;
  let lastInput: ProviderRunInput | null = null;

  const runtime: TurnProviderRuntime & {
    pendingBackgroundWork?: () => "none" | "pending";
  } = {
    resolveModelRoute(selection: ModelSelection) {
      const err = options.resolveError?.(selection);
      if (err) throw err;
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
      lastCallbacks = callbacks;
      lastInput = input;
      try {
        if (options.onRun) return await options.onRun(input, callbacks);
        callbacks.onStarted?.();
        return {
          providerId: input.providerId,
          conversationId: input.conversationId,
          runId: input.runId,
          turnId: input.turnId,
          status: "completed",
          terminalReason: { outcome: "completed", reason: "provider-completed" },
          text: "Done",
          textTruncated: false,
          exitCode: 0,
          signal: null,
          cleanupConfirmed: true,
        };
      } finally {
        if (runningConversation === input.conversationId) runningConversation = null;
      }
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

  return {
    runtime,
    getLastCallbacks: () => lastCallbacks,
    getLastInput: () => lastInput,
  };
}

describe("Phase 5 Package 3: config-while-running, session overwrite guard, per-item selection, H6 & N8", () => {
  it("allows conversation.update while an agent turn is running and wakes the queue, while keeping non-turn guards", async () => {
    const { store, conversation, claudeSelection } = createEnv();
    const { runtime } = makeProviderRuntime();
    const schedule = vi.fn();
    const conversations = createConversationCommandHandler({
      store,
      providers: runtime as never,
      backendProfileController: {
        isExternalSelection: () => false,
        validateSelection: (selection: ModelSelection) => selection,
        supportsNativeFastModeControl: () => false,
      } as never,
      queuedMessages: { schedule },
    } as unknown as ConversationCommandDependencies);

    // Active agent workspace run (normal running turn — NOT in conversationWork).
    const activeTurnRun = store.createWorkspaceRun({
      kind: "agent",
      projectId: conversation.projectId,
      conversationId: conversation.id,
      label: "Codex · gpt-5",
      detail: conversation.title,
      status: "running",
      port: null,
    });
    expect(store.hasRecordedActiveWorkspaceRunForConversation(conversation.id)).toBe(true);

    const updateCommand: Extract<ClientCommand, { type: "conversation.update" }> = {
      type: "conversation.update",
      requestId: randomUUID(),
      payload: {
        conversationId: conversation.id,
        providerId: "claude",
        modelSelection: claudeSelection,
        interactionMode: "plan",
        accessMode: "auto-edit",
      },
    };
    await expect(conversations({} as never, updateCommand)).resolves.toBe("mutation");
    const updated = store.conversation(conversation.id);
    expect(updated.providerId).toBe("claude");
    expect(updated.modelSelection.modelId).toBe("claude-sonnet-4");
    expect(updated.interactionMode).toBe("plan");
    expect(updated.accessMode).toBe("auto-edit");
    expect(schedule).toHaveBeenCalledWith(conversation.id);

    // Non-turn guard: checkout-restore / isolated review reservation still refuses.
    store.updateWorkspaceRun(activeTurnRun.id, { status: "succeeded" });
    expect(store.conversationWork.reserve(conversation.id)).toBe(true);
    expect(store.conversationWork.claimRestoreCheckout(conversation.id)).toBe(true);
    await expect(conversations({} as never, {
      type: "conversation.update",
      requestId: randomUUID(),
      payload: { conversationId: conversation.id, interactionMode: "build" },
    })).rejects.toThrow("Stop the active run or review before changing its agent configuration.");
    store.conversationWork.release(conversation.id);
  });

  it("guards conversations.providerSessionId against active-turn overwrite after mid-turn provider switch, while preserving V2 backing and steer-read marks", async () => {
    const { store, conversation, claudeSelection } = createEnv();
    let resolveRun!: (result: ProviderRunResult) => void;
    let capturedCallbacks: ProviderRunCallbacks | null = null;
    let capturedInput: ProviderRunInput | null = null;
    const { runtime } = makeProviderRuntime({
      onRun: async (input, callbacks) => {
        capturedCallbacks = callbacks;
        capturedInput = input;
        callbacks.onStarted?.();
        return await new Promise<ProviderRunResult>((resolve) => {
          resolveRun = resolve;
        });
      },
    });
    const controller = new TurnController(
      store,
      runtime,
      new Map<string, AgentApprovalRequest>(),
      new Map<string, AgentInputRequest>(),
      new Map<string, AgentPlan>(),
      {
        broadcast: vi.fn(),
        broadcastSnapshot: vi.fn(),
        providerInfo: () => makeProviderInfo(),
      },
    );
    const conversations = createConversationCommandHandler({
      store,
      providers: runtime as never,
      backendProfileController: {
        isExternalSelection: () => false,
        validateSelection: (selection: ModelSelection) => selection,
        supportsNativeFastModeControl: () => false,
      } as never,
    } as unknown as ConversationCommandDependencies);

    const queued = controller.queue({ conversationId: conversation.id, content: "Run on Codex" });
    expect(controller.start(queued.turn.id)).toBe(true);
    await vi.waitFor(() => expect(capturedCallbacks).not.toBeNull());

    // Record an accepted steer effect and invoke onSteerRead from harness callbacks.
    const steerCommandId = `steer-cmd-${randomUUID()}`;
    let steerRequest = null as ReturnType<typeof store.orchestration.runControl.requestSteer> | null;
    const steerStart = await store.orchestration.authority.begin({
      source: { actorId: "human", commandId: steerCommandId, command: { type: "message.follow-up" } },
      threadId: conversation.id,
      projectId: conversation.projectId,
      commandType: "message.follow-up",
      rejection: null,
    }, (ticket) => {
      steerRequest = store.orchestration.runControl.requestSteer(ticket, queued.turn.runId, queued.turn.id);
    });
    expect(steerStart.kind).toBe("lead");
    expect(steerRequest).toMatchObject({ kind: "requested" });
    const effectId = steerRequest?.kind === "requested" ? steerRequest.effectId : "";
    if (steerStart.kind === "lead") steerStart.ticket.finish(null);
    store.orchestration.runControl.settleSteer(effectId, "accepted", { messageId: queued.message.id });
    const readAt = "2026-11-26T20:10:00.000Z";
    capturedCallbacks!.onSteerRead?.(effectId, readAt);
    expect(store.orchestration.runControl.steer(effectId)?.readAt).toBe(readAt);

    // Switch conversation to Claude mid-turn (Decision 4.8).
    await expect(conversations({} as never, {
      type: "conversation.update",
      requestId: randomUUID(),
      payload: {
        conversationId: conversation.id,
        providerId: "claude",
        modelSelection: claudeSelection,
      },
    })).resolves.toBe("mutation");
    expect(store.conversation(conversation.id).providerId).toBe("claude");
    expect(store.conversation(conversation.id).providerSessionId).toBeNull();

    // Now Turn 1 (on Codex) emits a session event and settles with sessionId.
    const sessionEvent: ProviderEvent = {
      type: "session",
      providerId: "codex",
      conversationId: conversation.id,
      runId: capturedInput!.runId,
      turnId: capturedInput!.turnId,
      sessionId: "codex-session-1",
    };
    capturedCallbacks!.onEvent?.(sessionEvent);

    // Conversation pointer MUST NOT be overwritten with Codex's session!
    expect(store.conversation(conversation.id).providerId).toBe("claude");
    expect(store.conversation(conversation.id).providerSessionId).toBeNull();
    // V2 backing for Codex MUST be durably recorded!
    const codexBacking = store.orchestration.backings.find({
      threadId: conversation.id,
      providerId: "codex",
      workspaceKey: store.conversationPath(conversation.id),
      identity: queued.turn.continuationIdentity,
      nativeSessionId: "codex-session-1",
    });
    expect(codexBacking?.nativeSessionId).toBe("codex-session-1");

    // Settle Turn 1 with sessionId: still MUST NOT overwrite Claude's conversation pointer!
    resolveRun({
      providerId: "codex",
      conversationId: conversation.id,
      runId: capturedInput!.runId,
      turnId: capturedInput!.turnId,
      status: "completed",
      terminalReason: { outcome: "completed", reason: "provider-completed" },
      sessionId: "codex-session-1",
      text: "Codex finished",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });
    await vi.waitFor(() => expect(store.agentTurn(queued.turn.id).status).toBe("completed"));
    await controller.drainSettlementTasks();
    expect(store.conversation(conversation.id).providerId).toBe("claude");
    expect(store.conversation(conversation.id).providerSessionId).toBeNull();
    expect(store.agentTurn(queued.turn.id).providerSessionAfter).toBe("codex-session-1");
  });

  it("resolves per-item modelSelectionOverride without mutating live conversation selection and blocks cleanly when disabled", () => {
    const { store, conversation, claudeSelection } = createEnv();
    store.updateConversation(conversation.id, { providerSessionId: "codex-live-session" });
    const { runtime } = makeProviderRuntime();

    const resolved = resolveTurnRequest({
      store,
      providers: runtime,
      hooks: {
        broadcast: vi.fn(),
        broadcastSnapshot: vi.fn(),
        providerInfo: () => makeProviderInfo(),
      },
      id: () => randomUUID(),
      now: () => "2026-11-26T20:20:00.000Z",
      clock: () => new Date("2026-11-26T20:20:00.000Z"),
    }, {
      conversationId: conversation.id,
      content: "Run this queued item on Claude",
      modelSelectionOverride: claudeSelection,
    });

    expect(resolved.input.providerId).toBe("claude");
    expect(resolved.input.modelSelection?.modelId).toBe("claude-sonnet-4");
    expect(resolved.input.providerSessionBefore).toBeNull();
    // Must not clear Codex's live providerSessionId on conversations!
    expect(resolved.input.providerSessionInvalidation).toBeUndefined();
    expect(store.conversation(conversation.id).providerId).toBe("codex");
    expect(store.conversation(conversation.id).providerSessionId).toBe("codex-live-session");

    // Disabled provider raises named QueuedSelectionProviderUnavailableError.
    expect(() => resolveTurnRequest({
      store,
      providers: runtime,
      hooks: {
        broadcast: vi.fn(),
        broadcastSnapshot: vi.fn(),
        providerInfo: () => makeProviderInfo({ claude: { canRun: false, statusMessage: "Claude Code is disabled." } }),
      },
      id: () => randomUUID(),
      now: () => "2026-11-26T20:21:00.000Z",
      clock: () => new Date("2026-11-26T20:21:00.000Z"),
    }, {
      conversationId: conversation.id,
      content: "Should block cleanly",
      modelSelectionOverride: claudeSelection,
    })).toThrowError(QueuedSelectionProviderUnavailableError);

    // Missing/removed backend profile in validateModelSelection raises QueuedSelectionProviderUnavailableError.
    try {
      resolveTurnRequest({
        store,
        providers: runtime,
        hooks: {
          broadcast: vi.fn(),
          broadcastSnapshot: vi.fn(),
          providerInfo: () => makeProviderInfo(),
          validateModelSelection: () => { throw new Error("Backend profile was removed."); },
        },
        id: () => randomUUID(),
        now: () => "2026-11-26T20:22:00.000Z",
        clock: () => new Date("2026-11-26T20:22:00.000Z"),
      }, {
        conversationId: conversation.id,
        content: "Missing backend",
        modelSelectionOverride: claudeSelection,
      });
      expect.unreachable("Expected QueuedSelectionProviderUnavailableError");
    } catch (error) {
      expect(error).toBeInstanceOf(QueuedSelectionProviderUnavailableError);
      expect((error as QueuedSelectionProviderUnavailableError).blockedReason).toBe("provider-disabled");
    }
  });

  it("keeps H6 background-work errors distinguishable and supports cross-provider switch-back with N18 coverage", () => {
    const { store, conversation, codexSelection } = createEnv();
    const { runtime } = makeProviderRuntime({ pendingBackgroundWork: () => "pending" });
    const checkout = store.conversationPath(conversation.id);
    const otherCheckout = join(store.conversationPath(conversation.id), "..", "other-checkout");
    mkdirSync(otherCheckout);

    // Seed a completed Codex turn and backing in another checkout, then move conversation so relocation triggers H6.
    const identity = continuationIdentityForSelection(codexSelection, null, false);
    const turn = store.beginOrchestratedAgentTurn({
      id: randomUUID(),
      conversationId: conversation.id,
      runId: randomUUID(),
      content: "Earlier Codex turn",
      providerId: "codex",
      modelSelection: codexSelection,
      continuationIdentity: identity,
      harnessId: "codex-app-server",
      backendProfileId: codexSelection.backendProfileId,
      model: "gpt-5",
      modelAlias: null,
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: null,
      usageAtStart: null,
      configurationRevision: 0,
      association: "authoritative",
    });
    store.orchestration.backings.observeSession(turn.turn, "codex-sess-relocate");
    store.updateAgentTurnLifecycle(turn.turn.id, {
      status: "completed",
      startedAt: turn.turn.requestedAt,
      completedAt: new Date().toISOString(),
      providerSessionAfter: "codex-sess-relocate",
    });
    const backing = store.orchestration.backings.find({
      threadId: conversation.id,
      providerId: "codex",
      workspaceKey: checkout,
      identity,
      nativeSessionId: "codex-sess-relocate",
    });
    expect(backing).not.toBeNull();
    expect(isItemCovered({ ...backing!, coveredThroughOrdinal: 1 }, turn.message.id, 1)).toBe(true);

    // Verify H6 error classes remain distinct for queue runtime holding.
    expect(new ContextHandoffBackgroundWorkError()).toBeInstanceOf(ContextHandoffBackgroundWorkError);
    expect(new CheckoutMoveBackgroundWorkError()).toBeInstanceOf(CheckoutMoveBackgroundWorkError);
    expect(new CheckoutMoveBackgroundWorkError()).not.toBeInstanceOf(ContextHandoffBackgroundWorkError);
    expect(providerInstanceId("codex", identity)).toMatch(/^[0-9a-f]{64}$/u);
    expect(runtime.pendingBackgroundWork?.()).toBe("pending");
  });

  it("N8: holds only the usage-limited provider even after another provider succeeds, and lifts on expiry/unknown/manual start", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-11-26T12:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const { store, conversation, codexSelection, claudeSelection } = createEnv();
      const resetAt = new Date(now + 10 * 60_000).toISOString();
      let codexAccount: UsageAccount | null = {
        id: "native:codex",
        providerId: "codex",
        providerLabel: "Codex",
        label: "Codex",
        email: "user@example.test",
        plan: "plus",
        identityKey: "codex-acct",
        sources: ["This computer"],
        status: "ready",
        detail: null,
        updatedAt: new Date(now).toISOString(),
        checkedAt: new Date(now).toISOString(),
        credits: null,
        canReset: false,
        windows: [{ id: "codex:primary", label: "5 hour", remainingPercent: 0, windowMinutes: 300, resetsAt: resetAt }],
      };

      const abort = new AbortController();
      const scheduler = new LimitResetScheduler({
        store,
        signal: abort.signal,
        enabled: true,
        readAccount: vi.fn(async () => codexAccount),
        cachedAccount: vi.fn((providerId) => (providerId === "codex" ? codexAccount : null)),
        busy: () => false,
        dispatch: vi.fn(async () => undefined),
        track: async (op) => op(),
        changed: vi.fn(),
      });

      // Turn 1 on Codex fails with usage limit.
      const t1 = store.beginAgentTurn({
        conversationId: conversation.id,
        runId: randomUUID(),
        content: "Codex turn 1",
        providerId: "codex",
        modelSelection: codexSelection,
        model: "gpt-5",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: 0,
        association: "authoritative",
        requestedAt: new Date(now - 5_000).toISOString(),
      }).turn;
      store.updateAgentTurnLifecycle(t1.id, { status: "failed", startedAt: t1.requestedAt, completedAt: new Date(now - 4_000).toISOString() });
      store.limitResets.markUsageLimited(t1.id);

      // Codex is held, Claude is NOT held.
      expect(scheduler.usageLimitHoldsQueue(conversation.id, "codex")).toEqual({ held: true, resetsAt: resetAt });
      expect(scheduler.usageLimitHoldsQueue(conversation.id, "claude")).toEqual({ held: false, resetsAt: null });

      // Turn 2 on Claude succeeds in between.
      store.updateConversation(conversation.id, { providerId: "claude", modelSelection: claudeSelection });
      const t2 = store.beginAgentTurn({
        conversationId: conversation.id,
        runId: randomUUID(),
        content: "Claude turn 2",
        providerId: "claude",
        modelSelection: claudeSelection,
        model: "claude-sonnet-4",
        reasoningEffort: "medium",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: 0,
        association: "authoritative",
        requestedAt: new Date(now - 2_000).toISOString(),
      }).turn;
      store.updateAgentTurnLifecycle(t2.id, { status: "completed", startedAt: t2.requestedAt, completedAt: new Date(now - 1_000).toISOString() });

      // Codex MUST STILL be held even though Claude succeeded in between!
      expect(scheduler.usageLimitHoldsQueue(conversation.id, "codex")).toEqual({ held: true, resetsAt: resetAt });
      expect(scheduler.usageLimitHoldsQueue(conversation.id, "claude")).toEqual({ held: false, resetsAt: null });

      // Unknown reset lifts the hold.
      const savedAccount = codexAccount;
      codexAccount = null;
      expect(scheduler.usageLimitHoldsQueue(conversation.id, "codex")).toEqual({ held: false, resetsAt: null });
      codexAccount = savedAccount;
      expect(scheduler.usageLimitHoldsQueue(conversation.id, "codex").held).toBe(true);

      // Expired reset lifts the hold.
      vi.setSystemTime(Date.parse(resetAt) + 1_000);
      codexAccount = { ...savedAccount!, updatedAt: new Date().toISOString() };
      expect(scheduler.usageLimitHoldsQueue(conversation.id, "codex")).toEqual({ held: false, resetsAt: null });

      // Reset time back before resetAt, then user manually starts a new Codex turn -> lifts hold.
      vi.setSystemTime(now);
      codexAccount = { ...savedAccount!, updatedAt: new Date(now).toISOString() };
      expect(scheduler.usageLimitHoldsQueue(conversation.id, "codex").held).toBe(true);
      store.updateConversation(conversation.id, { providerId: "codex", modelSelection: codexSelection });
      store.beginAgentTurn({
        conversationId: conversation.id,
        runId: randomUUID(),
        content: "Manual retry on Codex",
        providerId: "codex",
        modelSelection: codexSelection,
        model: "gpt-5",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: 0,
        association: "authoritative",
        requestedAt: new Date(now + 1_000).toISOString(),
      });
      expect(scheduler.usageLimitHoldsQueue(conversation.id, "codex")).toEqual({ held: false, resetsAt: null });
      abort.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it("S1: dispatches a queued item with pinned Provider A selection after switching chat to Provider B, and holds cleanly on disabled provider (H4) and busy session (H6)", async () => {
    const { directory, store, conversation, codexSelection, claudeSelection } = createEnv();
    const attachments = await ConversationAttachmentStore.open(directory);
    const abort = new AbortController();
    const runs: Array<{ providerId: string; prompt: string }> = [];
    let currentProviders = makeProviderInfo();
    let resolveTurn1!: (result: ProviderRunResult) => void;
    let busyBackground = false;
    const { runtime } = makeProviderRuntime({
      onRun: async (input, callbacks) => {
        runs.push({ providerId: input.providerId, prompt: input.prompt });
        callbacks.onStarted?.();
        if (runs.length === 1) {
          return await new Promise<ProviderRunResult>((resolve) => { resolveTurn1 = resolve; });
        }
        return {
          providerId: input.providerId,
          conversationId: input.conversationId,
          runId: input.runId,
          turnId: input.turnId,
          status: "completed",
          terminalReason: { outcome: "completed", reason: "provider-completed" },
          text: "Done",
          textTruncated: false,
          exitCode: 0,
          signal: null,
          cleanupConfirmed: true,
        };
      },
    });
    const tasks = new Set<Promise<unknown>>();
    let queue!: ReturnType<typeof createQueuedMessageRuntime>;
    const controller = new TurnController(
      store,
      runtime,
      new Map<string, AgentApprovalRequest>(),
      new Map<string, AgentInputRequest>(),
      new Map<string, AgentPlan>(),
      {
        broadcast: vi.fn(),
        broadcastSnapshot: vi.fn(),
        providerInfo: () => currentProviders,
        onTurnSettled: (turn) => queue.onTurnSettled(turn),
      },
    );
    const dependencies: TurnInteractionCommandDependencies = {
      store,
      turns: controller,
      conversationAttachments: attachments,
      backendProfileController: {
        validateSelection: (selection: ModelSelection) => selection,
        isExternalSelection: () => false,
        readiness: async () => null,
      } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
      isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
      workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
      pendingApprovals: new Map(),
      pendingInputs: new Map(),
      dataDirectory: directory,
      enableProviders: true,
      attachmentResolver: null,
      generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
      workflows: { resolveTurnSkills: async () => ({ inputs: [], routeKey: null }), assertTurnSkillsCurrent: () => undefined } as unknown as TurnInteractionCommandDependencies["workflows"],
      providerTerminalResumes: { isActive: () => false, acquireWhenAvailable: async () => true, release: () => undefined } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
      providerInfo: () => currentProviders,
      broadcast: () => undefined,
      broadcastSnapshot: () => undefined,
      send: () => undefined,
    };
    queue = createQueuedMessageRuntime(dependencies, {
      signal: abort.signal,
      track: (op) => {
        const task = op();
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
        return task;
      },
    });
    const drain = async () => {
      await Promise.resolve();
      while (tasks.size > 0) await Promise.allSettled(tasks);
      await controller.drainSettlementTasks();
      while (tasks.size > 0) await Promise.allSettled(tasks);
    };

    try {
      // Turn 1 starts on Codex.
      const turn1 = controller.queue({ conversationId: conversation.id, content: "Turn 1 on Codex" });
      expect(controller.start(turn1.turn.id)).toBe(true);
      await vi.waitFor(() => expect(runs).toHaveLength(1));

      // Enqueue pinned Codex item while Turn 1 runs, then switch chat to Claude mid-turn.
      const pinnedCodexId = randomUUID();
      await queue.handler(null as unknown as WebSocket, {
        type: "message.queue.enqueue",
        requestId: randomUUID(),
        payload: { conversationId: conversation.id, id: pinnedCodexId, content: "Pinned for Codex", attachments: [] },
      });
      store.updateConversation(conversation.id, { providerId: "claude", modelSelection: claudeSelection });
      expect(store.conversation(conversation.id).providerId).toBe("claude");

      // Complete Turn 1 -> pinned Codex item MUST still run on Codex, not Claude!
      resolveTurn1({
        providerId: "codex",
        conversationId: conversation.id,
        runId: turn1.turn.runId,
        turnId: turn1.turn.id,
        status: "completed",
        terminalReason: { outcome: "completed", reason: "provider-completed" },
        text: "Turn 1 done",
        textTruncated: false,
        exitCode: 0,
        signal: null,
        cleanupConfirmed: true,
      });
      await vi.waitFor(() => expect(runs).toHaveLength(2));
      await drain();
      expect(runs[1]!.providerId).toBe("codex");
      expect(runs[1]!.prompt).toContain("Pinned for Codex");
      expect(store.conversation(conversation.id).providerId).toBe("claude");

      // Disabled provider blocks item with provider-disabled and holds queue with H4-start-failure.
      const disabledId = randomUUID();
      const followerId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: conversation.id,
        itemId: disabledId,
        content: "Needs disabled Codex",
        modelSelection: codexSelection,
      });
      store.orchestration.queue.enqueue({
        conversationId: conversation.id,
        itemId: followerId,
        content: "Follower item",
        modelSelection: claudeSelection,
      });
      currentProviders = makeProviderInfo({ codex: { canRun: false, statusMessage: "Codex is disabled." } });
      await queue.sendNow(conversation.id, disabledId, randomUUID());
      await drain();
      expect(store.orchestration.queue.getItem(disabledId)).toMatchObject({
        state: "blocked",
        blockedReason: "provider-disabled",
        queueHeld: true,
      });
      expect(store.orchestration.queue.getItem(followerId)).toMatchObject({
        state: "waiting",
        queueHeld: true,
      });
      expect(computeQueueHoldReason(store, conversation.id, store.orchestration.queue.listActive(conversation.id))).toBe("provider-failed");

      // Busy replaced session (H6) returns item to waiting (not lost/blocked) and holds queue with H6-busy-session.
      store.orchestration.queue.cancel({ conversationId: conversation.id, itemId: disabledId, reason: "user" });
      store.orchestration.queue.release({ conversationId: conversation.id, cause: "R3-resume", itemIds: [followerId] });
      currentProviders = makeProviderInfo();
      const queueSpy = vi.spyOn(controller, "queue").mockImplementationOnce(() => {
        busyBackground = true;
        throw new ContextHandoffBackgroundWorkError();
      });
      await queue.sendNow(conversation.id, followerId, randomUUID());
      await drain();
      queueSpy.mockRestore();
      expect(busyBackground).toBe(true);
      expect(store.orchestration.queue.getItem(followerId)).toMatchObject({
        state: "waiting",
        queueHeld: true,
      });
      expect(computeQueueHoldReason(store, conversation.id, store.orchestration.queue.listActive(conversation.id))).toBe("busy-session");
    } finally {
      abort.abort();
      await drain();
      await controller.dispose();
      await attachments.close();
    }
  });

  it("S10: usageLimitHoldsQueue is provider-scoped — Provider B dispatches immediately while Provider A stays held even after Provider B succeeds", async () => {
    const { directory, store, conversation, codexSelection, claudeSelection } = createEnv();
    const attachments = await ConversationAttachmentStore.open(directory);
    const abort = new AbortController();
    const runs: Array<{ providerId: string; prompt: string }> = [];
    const { runtime } = makeProviderRuntime({
      onRun: async (input, callbacks) => {
        runs.push({ providerId: input.providerId, prompt: input.prompt });
        callbacks.onStarted?.();
        return {
          providerId: input.providerId,
          conversationId: input.conversationId,
          runId: input.runId,
          turnId: input.turnId,
          status: "completed",
          terminalReason: { outcome: "completed", reason: "provider-completed" },
          text: "Completed",
          textTruncated: false,
          exitCode: 0,
          signal: null,
          cleanupConfirmed: true,
        };
      },
    });
    const tasks = new Set<Promise<unknown>>();
    let queue!: ReturnType<typeof createQueuedMessageRuntime>;
    const controller = new TurnController(
      store,
      runtime,
      new Map<string, AgentApprovalRequest>(),
      new Map<string, AgentInputRequest>(),
      new Map<string, AgentPlan>(),
      {
        broadcast: vi.fn(),
        broadcastSnapshot: vi.fn(),
        providerInfo: () => makeProviderInfo(),
        onTurnSettled: (turn) => queue.onTurnSettled(turn),
      },
    );
    const dependencies: TurnInteractionCommandDependencies = {
      store,
      turns: controller,
      conversationAttachments: attachments,
      backendProfileController: {
        validateSelection: (selection: ModelSelection) => selection,
        isExternalSelection: () => false,
        readiness: async () => null,
      } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
      isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
      workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
      pendingApprovals: new Map(),
      pendingInputs: new Map(),
      dataDirectory: directory,
      enableProviders: true,
      attachmentResolver: null,
      generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
      workflows: { resolveTurnSkills: async () => ({ inputs: [], routeKey: null }), assertTurnSkillsCurrent: () => undefined } as unknown as TurnInteractionCommandDependencies["workflows"],
      providerTerminalResumes: { isActive: () => false, acquireWhenAvailable: async () => true, release: () => undefined } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
      providerInfo: () => makeProviderInfo(),
      broadcast: () => undefined,
      broadcastSnapshot: () => undefined,
      send: () => undefined,
    };
    queue = createQueuedMessageRuntime(dependencies, {
      signal: abort.signal,
      track: (op) => {
        const task = op();
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
        return task;
      },
    });
    const drain = async () => {
      await Promise.resolve();
      while (tasks.size > 0) await Promise.allSettled(tasks);
      await controller.drainSettlementTasks();
      while (tasks.size > 0) await Promise.allSettled(tasks);
    };

    try {
      const now = Date.now();
      const futureReset = new Date(now + 15 * 60_000).toISOString();
      // Turn 1 on Codex fails with usage limit + active future reset plan.
      const t1 = store.beginAgentTurn({
        conversationId: conversation.id,
        runId: randomUUID(),
        content: "Codex turn 1",
        providerId: "codex",
        modelSelection: codexSelection,
        model: "gpt-5",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: 0,
        association: "authoritative",
        requestedAt: new Date(now - 5_000).toISOString(),
      }).turn;
      store.updateAgentTurnLifecycle(t1.id, { status: "failed", startedAt: t1.requestedAt, completedAt: new Date(now - 4_000).toISOString() });
      store.limitResets.markUsageLimited(t1.id);
      store.limitResets.save({
        id: randomUUID(),
        conversationId: conversation.id,
        failedTurnId: t1.id,
        resetsAt: futureReset,
        routeIdentity: "",
        accountIdentity: "codex-acct",
        nextAttemptAt: futureReset,
        attempts: 0,
        state: "waiting",
        error: null,
        turnId: null,
      });

      expect(usageLimitHoldsQueue(store, conversation.id, codexSelection, now)).toBe(true);
      expect(usageLimitHoldsQueue(store, conversation.id, claudeSelection, now)).toBe(false);

      // Enqueue Claude item first, then Codex item second.
      const claudeItemId = randomUUID();
      const codexItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: conversation.id,
        itemId: claudeItemId,
        content: "Run on Claude while Codex is limited",
        modelSelection: claudeSelection,
      });
      store.orchestration.queue.enqueue({
        conversationId: conversation.id,
        itemId: codexItemId,
        content: "Wait for Codex reset",
        modelSelection: codexSelection,
      });

      // Settle notification triggers drain: Claude item MUST dispatch immediately!
      queue.onTurnSettled(store.agentTurn(t1.id));
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      await drain();
      expect(runs[0]!.providerId).toBe("claude");
      expect(runs[0]!.prompt).toContain("Run on Claude while Codex is limited");
      expect(store.orchestration.queue.getItem(claudeItemId)?.state).toBe("delivered");

      // After Claude completes, Codex item MUST STILL be held because Codex's reset window is still active!
      expect(usageLimitHoldsQueue(store, conversation.id, codexSelection, Date.now())).toBe(true);
      expect(store.orchestration.queue.getItem(codexItemId)?.state).toBe("waiting");
      expect(runs).toHaveLength(1);
    } finally {
      abort.abort();
      await drain();
      await controller.dispose();
      await attachments.close();
    }
  });
});
