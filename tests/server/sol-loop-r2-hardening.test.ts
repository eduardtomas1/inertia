import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInputRequest, ModelSelection } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { privateConnectPromptSafetyForHarness } from "../../src/shared/private-connect/prompt-safety";
import { RuntimeStore } from "../../src/server/database";
import { OrchestrationConflict } from "../../src/server/orchestration-v2/types";
import { handlePrivateConnectQueueCommand, projectPrivateConnectQueue } from "../../src/server/private-connect/queue-gateway";
import { PrivateConnectRuntimeGateway } from "../../src/server/private-connect/runtime-gateway";
import { sendMessageCommand, QUEUE_ATTRIBUTION_STALE_CODE } from "../../src/server/runtime/commands/message-send-command";
import { executeManagedQueueMutation } from "../../src/server/runtime/managed-queue-tools";
import { registerPendingInteraction } from "../../src/server/runtime/pending-interaction-registry";
import { reconcileQueueOnBoot } from "../../src/server/runtime/queue-boot-reconciliation";
import { createScheduledTaskRuntime, resolveScheduledTaskEffectiveModelSelection } from "../../src/server/runtime/scheduled-tasks/scheduled-task-runtime";
import { ScheduledTaskService } from "../../src/server/runtime/scheduled-tasks/scheduled-task-service";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-types";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import { RuntimeRequestError } from "../../src/server/runtime-errors";

const tempDirs: string[] = [];

function createTempStore(): { root: string; workspace: string; store: RuntimeStore } {
  const root = mkdtempSync(join(tmpdir(), "inertia-sol-r2-"));
  tempDirs.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace);
  return { root, workspace, store };
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("sol-loop Wave A+B R2 hardening (S39 final admission, S41-S46)", () => {
  it("S42: blocks steering a scheduled task item in the shared queue.claim path", () => {
    const { store, workspace } = createTempStore();
    try {
      const project = store.createProject("S42 Project", workspace);
      const conversation = store.createConversation(project.id, "Bound chat");
      const itemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: conversation.id,
        itemId,
        content: "Run scheduled check",
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        attribution: {
          scheduledTask: {
            taskId: randomUUID(),
            runId: randomUUID(),
            title: "Scheduled check",
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });

      expect(() => store.orchestration.queue.claim({
        conversationId: conversation.id,
        itemId,
        mode: "steer",
      })).toThrow(OrchestrationConflict);

      const runClaim = store.orchestration.queue.claim({
        conversationId: conversation.id,
        itemId,
        mode: "run",
      });
      expect(runClaim.value.state).toBe("dispatching");
    } finally {
      store.close();
    }
  });

  it("S45: settles scheduled occurrences on any queue.cancel (Private Connect / managed / direct) so Run now succeeds again", async () => {
    const { store, workspace } = createTempStore();
    try {
      const project = store.createProject("S45 Project", workspace);
      const conversation = store.createConversation(project.id, "Bound chat");
      const broadcasts: unknown[] = [];
      const service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => conversation,
        broadcast: (event) => broadcasts.push(event),
      });
      store.orchestration.queue.onCancel((item, reason) => {
        if (item.attribution && "scheduledTask" in item.attribution) {
          service.onRunQueueCancelled(item.attribution.scheduledTask.runId, reason, { alreadySettledInStore: true });
        }
      });

      const task = service.create({
        projectId: project.id,
        title: "Cancellable schedule",
        prompt: "Check repo",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: conversation.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
      });

      const first = await service.runNow(task.id);
      expect(first.run.queueItemId).toBeTruthy();
      expect(store.scheduledTasks.hasActiveQueuedOrRunningOccurrence(task.id)).toBe(true);

      // Cancel directly through OrchestrationQueueRepository (same path as Private Connect & inertia_queue).
      store.orchestration.queue.cancel({
        conversationId: conversation.id,
        itemId: first.run.queueItemId!,
        reason: "user",
      });

      expect(store.scheduledTasks.getRun(first.run.id)?.state).toBe("skipped");
      expect(store.scheduledTasks.hasActiveQueuedOrRunningOccurrence(task.id)).toBe(false);

      // Run now immediately succeeds again without waiting for restart.
      const second = await service.runNow(task.id);
      expect(second.run.id).not.toBe(first.run.id);
      expect(second.run.state).toBe("queued");
    } finally {
      store.close();
    }
  });

  it("S46: does not arm a zero-delay spinning timer when enableProviders is false", async () => {
    vi.useFakeTimers();
    const { store, workspace } = createTempStore();
    try {
      const project = store.createProject("S46 Project", workspace);
      const conversation = store.createConversation(project.id, "Chat");
      let nowMs = Date.parse("2026-11-27T12:00:00.000Z");
      const service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => conversation,
        broadcast: () => undefined,
        now: () => new Date(nowMs),
        enableProviders: false,
      });
      const task = service.create({
        projectId: project.id,
        title: "Disabled providers schedule",
        prompt: "Do nothing while disabled",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: conversation.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
      });
      nowMs = Date.parse(task.nextRunAt!) + 1_000;

      service.start();
      await service.tick();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it("S41: enforces effective provider route prompt safety for unbound scheduled tasks at gateway and at final admission", async () => {
    const { store, workspace } = createTempStore();
    try {
      const project = store.createProject("S41 Project", workspace);
      // Set app default provider to an unsafe harness (`pi-rpc`) and create an unbound task with modelSelection: null.
      store.updateSettings({ defaultProvider: "pi" });
      const runtime = createScheduledTaskRuntime({
        store,
        creation: () => ({
          create: async (payload) => store.createConversation(payload.projectId, payload.title, {
            accessMode: payload.accessMode,
            interactionMode: payload.interactionMode,
            modelSelection: payload.modelSelection,
            activate: false,
          }),
        }),
        messageQueue: () => undefined,
        broadcast: () => undefined,
        broadcastSnapshot: () => undefined,
        broadcastConversationShell: () => undefined,
      });
      const task = runtime.service.create({
        projectId: project.id,
        title: "Unbound default route task",
        prompt: "Inspect repo",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: null,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
      });

      const resolved = resolveScheduledTaskEffectiveModelSelection(store, project.id, task.modelSelection);
      expect(resolved.harnessId).toBe("pi-rpc");

      const gateway = new PrivateConnectRuntimeGateway({
        shell: () => store.snapshot() as never,
        conversation: (id) => { try { return store.conversation(id); } catch { return null; } },
        detail: () => null,
        isConversationActive: () => false,
        preparePrompt: async () => undefined,
        queuePrompt: () => ({ turnId: null }),
        scheduledTasks: runtime.privateConnectHandlers,
      });

      const subject = {
        deviceId: "dev-1",
        scopes: ["view", "prompt"] as const,
        projectIds: [project.id],
        grants: [{ projectId: project.id, conversationIds: [], includeFutureConversations: true, legacyProjectWide: false }],
      };

      const toggleRes = await gateway.request(subject as never, {
        type: "scheduled-task.toggle",
        requestId: randomUUID(),
        taskId: task.id,
        enabled: true,
      });
      expect(toggleRes.ok).toBe(false);
      if (!toggleRes.ok) expect(toggleRes.code).toBe("forbidden");

      const runNowRes = await gateway.request(subject as never, {
        type: "scheduled-task.run-now",
        requestId: randomUUID(),
        taskId: task.id,
      });
      expect(runNowRes.ok).toBe(false);
      if (!runNowRes.ok) expect(runNowRes.code).toBe("forbidden");

      // Now switch app default to safe Codex, run via Private Connect (which queues with requirePrivateConnectPromptSafety: true),
      // then switch the created chat to unsafe kimi-acp before final turn admission -> admission must reject!
      store.updateSettings({ defaultProvider: "codex" });
      const safeRunRes = await gateway.request(subject as never, {
        type: "scheduled-task.run-now",
        requestId: randomUUID(),
        taskId: task.id,
      });
      expect(safeRunRes.ok).toBe(true);
      const runs = store.scheduledTasks.listRuns(task.id);
      const activeRun = runs[0]!;
      expect(activeRun.queueItemId).toBeTruthy();
      const targetConvId = activeRun.conversationId!;
      const unsafeSelection: ModelSelection = providerNativeModelSelection({ providerId: "pi", modelId: "provider-default" });
      store.updateConversation(targetConvId, { modelSelection: unsafeSelection });

      const v2Item = store.orchestration.queue.getItem(activeRun.queueItemId!)!;
      expect(v2Item.attribution && "scheduledTask" in v2Item.attribution && v2Item.attribution.scheduledTask.requirePrivateConnectPromptSafety).toBe(true);
      store.orchestration.queue.claim({ conversationId: targetConvId, itemId: v2Item.id, mode: "run" });

      const deps = {
        store,
        queuedMessage: {
          ...store.queuedMessages.get(targetConvId, v2Item.id)!,
          state: "dispatching" as const,
          dispatchOrdinal: 1,
          editRevision: 0,
        },
        scheduledDelivery: {
          taskId: task.id,
          runId: activeRun.id,
          title: task.title,
          accessMode: "supervised" as const,
          interactionMode: "build" as const,
          requirePrivateConnectPromptSafety: true,
        },
        turns: {
          acquireTurnAdmission: async () => ({ conversationId: targetConvId, token: Symbol("adm"), release: vi.fn() }),
          isActive: () => false,
          isClosing: () => false,
          isReleasing: () => false,
          activeIdentity: () => null,
          queue: vi.fn(),
        },
        conversationAttachments: { retain: async () => [], acceptRetention: vi.fn(), releaseRetention: vi.fn() },
        backendProfileController: {
          validateSelection: (s: ModelSelection) => s,
          isExternalSelection: () => false,
          readiness: async () => ({ ready: true }),
        },
        isolatedRuns: { has: () => false },
        workspaceRuns: { has: () => false },
        pendingApprovals: new Map(),
        pendingInputs: new Map(),
        dataDirectory: workspace,
        enableProviders: true,
        attachmentResolver: null,
        generatedAttachments: { release: vi.fn() },
        workflows: { resolveTurnSkills: async () => ({ routeKey: null, skills: [] }), assertTurnSkillsCurrent: vi.fn() },
        providerTerminalResumes: { isActive: () => false, acquire: () => true, acquireWhenAvailable: async () => true, release: vi.fn() },
        providerInfo: () => [],
        broadcast: vi.fn(),
        broadcastSnapshot: vi.fn(),
        send: vi.fn(),
      } as unknown as TurnInteractionCommandDependencies;

      await expect(sendMessageCommand(deps, null as never, {
        type: "message.send",
        requestId: v2Item.id,
        payload: { conversationId: targetConvId, content: task.prompt, attachments: [], activate: false },
      })).rejects.toThrow(privateConnectPromptSafetyForHarness("pi-rpc").explanation);
      expect(deps.turns.queue).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("S44: boot reconciliation preserves real scheduledTask attribution across both crash points and honors recorded Stop", async () => {
    const { store, workspace } = createTempStore();
    try {
      const project = store.createProject("S44 Project", workspace);

      // Crash point 1: unclaimed/waiting real scheduled queue item -> must NOT be held, gets bootAutoResend.
      const conv1 = store.createConversation(project.id, "Crash point 1");
      const task1 = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Boot crash 1",
        prompt: "Run after boot",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: conv1.id,
        freshSession: true,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
        nextRunAt: "2026-11-27T13:00:00.000Z",
        now: "2026-11-27T12:00:00.000Z",
      });
      const run1Id = randomUUID();
      store.scheduledTasks.claimRun({
        runId: run1Id,
        taskId: task1.id,
        claimKey: `manual:${task1.id}:${run1Id}`,
        trigger: "manual",
        scheduledFor: null,
        claimedAt: "2026-11-27T12:00:00.000Z",
        nextRunAtAfterClaim: "2026-11-27T13:00:00.000Z",
      });
      const item1Id = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: conv1.id,
        itemId: item1Id,
        content: task1.prompt,
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        followsThreadSelection: true,
        freshContext: true,
        attribution: {
          scheduledTask: {
            taskId: task1.id,
            runId: run1Id,
            title: task1.title,
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });
      store.scheduledTasks.updateRun(run1Id, {
        state: "queued",
        conversationId: conv1.id,
        queueItemId: item1Id,
        updatedAt: "2026-11-27T12:00:01.000Z",
      });

      // Crash point 2: admitted-but-never-started scheduled turn (`interrupted`, `not-delivered`) -> requeued preserving attribution & freshContext!
      const conv2 = store.createConversation(project.id, "Crash point 2");
      const task2 = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Boot crash 2",
        prompt: "Run admitted before crash",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: conv2.id,
        freshSession: true,
        accessMode: "supervised",
        interactionMode: "plan",
        modelSelection: null,
        nextRunAt: "2026-11-27T13:00:00.000Z",
        now: "2026-11-27T12:00:00.000Z",
      });
      const run2Id = randomUUID();
      store.scheduledTasks.claimRun({
        runId: run2Id,
        taskId: task2.id,
        claimKey: `manual:${task2.id}:${run2Id}`,
        trigger: "manual",
        scheduledFor: null,
        claimedAt: "2026-11-27T12:00:00.000Z",
        nextRunAtAfterClaim: "2026-11-27T13:00:00.000Z",
      });
      const item2Id = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: conv2.id,
        itemId: item2Id,
        content: task2.prompt,
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        followsThreadSelection: true,
        freshContext: true,
        attribution: {
          scheduledTask: {
            taskId: task2.id,
            runId: run2Id,
            title: task2.title,
            interactionMode: "plan",
            accessMode: "supervised",
          },
        },
      });
      store.orchestration.queue.claim({ conversationId: conv2.id, itemId: item2Id, mode: "run" });
      const turn2Id = randomUUID();
      const turn2RunId = `run-${randomUUID()}`;
      store.beginOrchestratedAgentTurn({
        id: turn2Id,
        conversationId: conv2.id,
        runId: turn2RunId,
        content: task2.prompt,
        activateConversation: false,
        queuedMessageId: item2Id,
        providerId: conv2.providerId,
        harnessId: conv2.modelSelection.harnessId,
        backendProfileId: conv2.modelSelection.backendProfileId,
        model: conv2.modelSelection.modelId,
        modelAlias: conv2.modelSelection.alias,
        reasoningEffort: conv2.modelSelection.reasoningEffort ?? "",
        interactionMode: "plan",
        accessMode: "supervised",
        providerSessionBefore: null,
        usageAtStart: null,
        configurationRevision: conv2.modelSelection.backendConfigurationRevision,
        association: "authoritative",
      });
      store.scheduledTasks.updateRun(run2Id, {
        state: "running",
        conversationId: conv2.id,
        queueItemId: item2Id,
        turnId: turn2Id,
        updatedAt: "2026-11-27T12:00:02.000Z",
      });
      store.scheduledTasks.update(task2.id, {
        now: "2026-11-27T12:00:02.000Z",
        lastRunStatus: "running",
        lastTurnId: turn2Id,
      });
      store.updateAgentTurnLifecycle(turn2Id, { status: "interrupted", terminalReason: "runtime-lost" });
      store.orchestration.synchronize(store.agentTurn(turn2Id));

      // Crash point 3: scheduled item with a recorded Stop -> must be HELD instead of auto-resent!
      const conv3 = store.createConversation(project.id, "Crash point 3 stopped");
      const item3Id = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: conv3.id,
        itemId: item3Id,
        content: "Stopped scheduled prompt",
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        attribution: {
          scheduledTask: {
            taskId: task1.id,
            runId: randomUUID(),
            title: "Stopped schedule",
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });
      store.orchestration.queue.hold({ conversationId: conv3.id, cause: "H1-stop", itemIds: [item3Id] });

      const report = await reconcileQueueOnBoot(store);

      // Crash point 1: unheld + bootAutoResend
      const after1 = store.orchestration.queue.getItem(item1Id)!;
      expect(after1.queueHeld).toBe(false);
      expect(after1.bootAutoResend).toBe(true);
      expect(report.resendsScheduled).toContain(item1Id);

      // Crash point 2: requeued unheld with preserved scheduledTask attribution, freshContext, followsThreadSelection!
      const after2 = store.orchestration.queue.getItem(item2Id)!;
      expect(after2.state).toBe("waiting");
      expect(after2.queueHeld).toBe(false);
      expect(after2.bootAutoResend).toBe(true);
      expect(after2.freshContext).toBe(true);
      expect(after2.followsThreadSelection).toBe(true);
      expect(after2.attribution).toEqual({
        scheduledTask: {
          taskId: task2.id,
          runId: run2Id,
          title: task2.title,
          interactionMode: "plan",
          accessMode: "supervised",
        },
      });

      // ScheduledTaskService.start() reconciles run2 back to `queued` instead of failing it!
      const service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => conv2,
        broadcast: () => undefined,
        enableProviders: false,
      });
      service.start();
      expect(store.scheduledTasks.getRun(run2Id)?.state).toBe("queued");
      // S55: task summary row is reconciled alongside the occurrence row!
      const reconciledTask2 = store.scheduledTasks.get(task2.id)!;
      expect(reconciledTask2.lastRunStatus).toBe("queued");
      expect(reconciledTask2.lastTurnId).toBeNull();

      // Crash point 3: recorded Stop keeps item3 held and NOT in resendsScheduled.
      const after3 = store.orchestration.queue.getItem(item3Id)!;
      expect(after3.queueHeld).toBe(true);
      expect(report.resendsScheduled).not.toContain(item3Id);
    } finally {
      store.close();
    }
  });

  it("S39 + S43: revalidates deleted scheduled occurrence and resolved childQuestionWake at final admission after async prep", async () => {
    const { store, workspace } = createTempStore();
    try {
      const project = store.createProject("S39/S43 Project", workspace);
      const parent = store.createConversation(project.id, "Parent chat");
      const child = store.createConversation(project.id, "Child chat");
      const parentTurn = store.beginAgentTurn({
        id: randomUUID(),
        conversationId: parent.id,
        runId: `run-${randomUUID()}`,
        content: "Spawn child",
        activateConversation: false,
        providerId: parent.providerId,
        harnessId: parent.modelSelection.harnessId,
        backendProfileId: parent.modelSelection.backendProfileId,
        model: parent.modelSelection.modelId,
        modelAlias: parent.modelSelection.alias,
        reasoningEffort: parent.modelSelection.reasoningEffort ?? "",
        interactionMode: parent.interactionMode,
        accessMode: parent.accessMode,
        providerSessionBefore: null,
        usageAtStart: null,
        configurationRevision: parent.modelSelection.backendConfigurationRevision,
        association: "authoritative",
      }).turn;
      store.settleAgentTurn(parentTurn.id, { status: "completed" });
      store.agentThreadManagement.attachManaged({
        childConversationId: child.id,
        sourceConversationId: parent.id,
        sourceTurnId: parentTurn.id,
        sourceRunId: parentTurn.runId,
        sourceHarnessId: parent.modelSelection.harnessId,
        now: "2026-11-27T12:00:00.000Z",
      });

      // S39: Scheduled item claimed, then owning task deleted DURING async preparation -> final admission withdraws claim.
      const task = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Deleted mid-prep",
        prompt: "Should not run after delete",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: parent.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
        nextRunAt: "2026-11-27T13:00:00.000Z",
        now: "2026-11-27T12:00:00.000Z",
      });
      const schedRunId = randomUUID();
      store.scheduledTasks.claimRun({
        runId: schedRunId,
        taskId: task.id,
        claimKey: `manual:${task.id}:${schedRunId}`,
        trigger: "manual",
        scheduledFor: null,
        claimedAt: "2026-11-27T12:00:00.000Z",
        nextRunAtAfterClaim: "2026-11-27T13:00:00.000Z",
      });
      const schedItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: parent.id,
        itemId: schedItemId,
        content: task.prompt,
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        attribution: {
          scheduledTask: {
            taskId: task.id,
            runId: schedRunId,
            title: task.title,
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });
      store.scheduledTasks.updateRun(schedRunId, {
        state: "queued",
        conversationId: parent.id,
        queueItemId: schedItemId,
        updatedAt: "2026-11-27T12:00:01.000Z",
      });

      const pendingInputs = new Map<string, AgentInputRequest>();
      const turnsQueueSpy = vi.fn();
      let duringPrepHook: (() => void) | null = () => {
        // Simulate task deletion happening during async preparation!
        store.scheduledTasks.delete(task.id);
      };
      const baseDeps = {
        store,
        turns: {
          acquireTurnAdmission: async () => ({ conversationId: parent.id, token: Symbol("adm"), release: vi.fn() }),
          isActive: (id: string) => id === child.id,
          isClosing: () => false,
          isReleasing: () => false,
          waitForProviderCleanup: async () => true,
          activeIdentity: () => null,
          queue: turnsQueueSpy,
        },
        conversationAttachments: {
          retain: async () => [],
          acceptRetention: vi.fn(),
          releaseRetention: vi.fn(),
        },
        verifyProviderInstallation: async () => {
          duringPrepHook?.();
        },
        backendProfileController: {
          validateSelection: (s: ModelSelection) => s,
          isExternalSelection: () => false,
          readiness: async () => ({ ready: true }),
        },
        isolatedRuns: { has: () => false },
        workspaceRuns: { has: () => false },
        pendingApprovals: new Map(),
        pendingInputs,
        dataDirectory: workspace,
        enableProviders: true,
        attachmentResolver: null,
        generatedAttachments: { release: vi.fn() },
        workflows: { resolveTurnSkills: async () => ({ routeKey: null, skills: [] }), assertTurnSkillsCurrent: vi.fn() },
        providerTerminalResumes: { isActive: () => false, acquire: () => true, acquireWhenAvailable: async () => true, release: vi.fn() },
        providerInfo: () => [],
        broadcast: vi.fn(),
        broadcastSnapshot: vi.fn(),
        send: vi.fn(),
      } as unknown as TurnInteractionCommandDependencies;

      const queueRuntime = createQueuedMessageRuntime(baseDeps, {
        signal: new AbortController().signal,
        track: (fn) => fn(),
      });
      await queueRuntime.start();
      await queueRuntime.schedule(parent.id);
      expect(turnsQueueSpy).not.toHaveBeenCalled();
      expect(store.orchestration.queue.getItem(schedItemId)?.state).toBe("cancelled");
      expect(store.orchestration.queue.getItem(schedItemId)?.cancelReason).toBe("withdrawn");

      // S43 + S47: register pending child input via production composite-key registry;
      // verify BOTH a live wake starts a turn AND a mid-prep resolved wake withdraws cleanly!
      const liveReqId = randomUUID();
      const liveChildRunId = `run-${randomUUID()}`;
      const liveChildTurnId = randomUUID();
      registerPendingInteraction(pendingInputs, {
        id: liveReqId,
        providerId: child.providerId,
        conversationId: child.id,
        turnId: liveChildTurnId,
        runId: liveChildRunId,
        kind: "question",
        questions: [{ id: "q-live", header: "Q", question: "Proceed?", options: [{ label: "Yes", description: "Go" }] }],
        createdAt: "2026-11-27T12:00:00.000Z",
      } as unknown as AgentInputRequest);
      const liveWakeItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: parent.id,
        itemId: liveWakeItemId,
        content: "Child needs live answer",
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        attribution: {
          childQuestionWake: {
            childConversationId: child.id,
            childRunId: liveChildRunId,
            requestId: liveReqId,
          },
        },
      });
      duringPrepHook = null;
      let liveParentTurnId = "";
      turnsQueueSpy.mockImplementationOnce(() => {
        const begun = store.beginAgentTurn({
          id: randomUUID(),
          conversationId: parent.id,
          runId: `run-${randomUUID()}`,
          content: "Child needs live answer",
          activateConversation: false,
          providerId: parent.providerId,
          harnessId: parent.modelSelection.harnessId,
          backendProfileId: parent.modelSelection.backendProfileId,
          model: parent.modelSelection.modelId,
          modelAlias: parent.modelSelection.alias,
          reasoningEffort: parent.modelSelection.reasoningEffort ?? "",
          interactionMode: parent.interactionMode,
          accessMode: parent.accessMode,
          providerSessionBefore: null,
          usageAtStart: null,
          configurationRevision: parent.modelSelection.backendConfigurationRevision,
          association: "authoritative",
        });
        liveParentTurnId = begun.turn.id;
        return { message: begun.message, turn: begun.turn };
      });
      (baseDeps.turns as unknown as { start: ReturnType<typeof vi.fn> }).start = vi.fn(() => true);
      await queueRuntime.schedule(parent.id);
      expect(turnsQueueSpy).toHaveBeenCalledTimes(1);
      store.settleAgentTurn(liveParentTurnId, { status: "completed" });

      // Now verify mid-prep resolution via composite key withdraws the stale claim!
      turnsQueueSpy.mockClear();
      const reqId = randomUUID();
      const childRunId = `run-${randomUUID()}`;
      const childTurnId = randomUUID();
      const staleInput = {
        id: reqId,
        providerId: child.providerId,
        conversationId: child.id,
        turnId: childTurnId,
        runId: childRunId,
        kind: "question",
        questions: [{ id: "q1", header: "Q", question: "Proceed?", options: [{ label: "Yes", description: "Go" }] }],
        createdAt: "2026-11-27T12:00:00.000Z",
      } as unknown as AgentInputRequest;
      registerPendingInteraction(pendingInputs, staleInput);
      const wakeItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: parent.id,
        itemId: wakeItemId,
        content: "Child needs answer",
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        attribution: {
          childQuestionWake: {
            childConversationId: child.id,
            childRunId,
            requestId: reqId,
          },
        },
      });
      // Simulate child answering its question during async preparation!
      duringPrepHook = () => {
        pendingInputs.clear();
      };
      await queueRuntime.schedule(parent.id);
      expect(turnsQueueSpy).not.toHaveBeenCalled();
      expect(store.orchestration.queue.getItem(wakeItemId)?.state).toBe("cancelled");
      expect(store.orchestration.queue.getItem(wakeItemId)?.cancelReason).toBe("withdrawn");

      // Verify QUEUE_ATTRIBUTION_STALE_CODE is exported and distinct.
      expect(QUEUE_ATTRIBUTION_STALE_CODE).toBe("queue-attribution-stale");
      expect(new RuntimeRequestError("stale", QUEUE_ATTRIBUTION_STALE_CODE).code).toBe(QUEUE_ATTRIBUTION_STALE_CODE);
    } finally {
      store.close();
    }
  });

  it("S48 + S49 + S50 + S51 + S53 + S54: desktop atomic remove, PC edit refusal, blocked delete, stale wake next item, late slash-command promote, and historical steer replay", async () => {
    const { store, workspace } = createTempStore();
    try {
      const project = store.createProject("R3 Hardening Project", workspace);
      const conv = store.createConversation(project.id, "Main chat");

      // S48 + S63 + S68 + S69: Desktop message.queue.remove atomically settles BOTH scheduled_task_runs AND scheduled_tasks summary (clearing prior lastTurnId) inside the same transaction, using current clock!
      const s48Now = new Date();
      const s48NowIso = s48Now.toISOString();
      const s48NextIso = new Date(s48Now.getTime() + 3_600_000).toISOString();
      const s48Task = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Desktop remove atomic",
        prompt: "Scheduled work",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
        nextRunAt: s48NextIso,
        now: s48NowIso,
      });
      const priorTurnId = randomUUID();
      store.scheduledTasks.update(s48Task.id, {
        now: s48NowIso,
        lastRunStatus: "completed",
        lastTurnId: priorTurnId,
        lastConversationId: conv.id,
      });
      const s48RunId = randomUUID();
      store.scheduledTasks.claimRun({
        runId: s48RunId,
        taskId: s48Task.id,
        claimKey: `manual:${s48Task.id}:${s48RunId}`,
        trigger: "manual",
        scheduledFor: null,
        claimedAt: s48NowIso,
        nextRunAtAfterClaim: s48NextIso,
      });
      const s48ItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: conv.id,
        itemId: s48ItemId,
        content: s48Task.prompt,
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        queueHeld: true,
        attribution: {
          scheduledTask: {
            taskId: s48Task.id,
            runId: s48RunId,
            title: s48Task.title,
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });
      store.scheduledTasks.updateRun(s48RunId, {
        state: "queued",
        conversationId: conv.id,
        queueItemId: s48ItemId,
        updatedAt: s48NowIso,
      });

      const dummyDeps = {
        store,
        turns: {
          acquireTurnAdmission: async () => ({ conversationId: conv.id, token: Symbol("adm"), release: vi.fn() }),
          isActive: () => false,
          isClosing: () => false,
          isReleasing: () => false,
          waitForProviderCleanup: async () => true,
          activeIdentity: () => null,
          queue: vi.fn(),
          start: vi.fn(() => true),
        },
        conversationAttachments: { retain: async () => [], release: async () => undefined, acceptRetention: vi.fn(), releaseRetention: vi.fn() },
        backendProfileController: { validateSelection: (s: ModelSelection) => s, isExternalSelection: () => false, readiness: async () => ({ ready: true }) },
        isolatedRuns: { has: () => false },
        workspaceRuns: { has: () => false },
        pendingApprovals: new Map(),
        pendingInputs: new Map(),
        dataDirectory: workspace,
        enableProviders: true,
        attachmentResolver: null,
        generatedAttachments: { release: vi.fn() },
        workflows: { resolveTurnSkills: async () => ({ routeKey: null, skills: [] }), assertTurnSkillsCurrent: vi.fn() },
        providerTerminalResumes: { isActive: () => false, acquire: () => true, acquireWhenAvailable: async () => true, release: vi.fn() },
        providerInfo: () => [],
        broadcast: vi.fn(),
        broadcastSnapshot: vi.fn(),
        send: vi.fn(),
      } as unknown as TurnInteractionCommandDependencies;
      // Intentionally omit onScheduledCancelled to prove DB transaction alone settled scheduled_task_runs!
      const desktopQueue = createQueuedMessageRuntime(dummyDeps, {
        signal: new AbortController().signal,
        track: (fn) => fn(),
      });
      await desktopQueue.start();
      await desktopQueue.handler(null as never, {
        type: "message.queue.remove",
        requestId: randomUUID(),
        payload: { conversationId: conv.id, id: s48ItemId },
      });
      // S48 + S63: Desktop message.queue.remove atomically settles BOTH scheduled_task_runs AND scheduled_tasks summary inside the same transaction (even without callback)!
      expect(store.orchestration.queue.getItem(s48ItemId)?.state).toBe("cancelled");
      expect(store.scheduledTasks.getRun(s48RunId)?.state).toBe("skipped");
      expect(store.scheduledTasks.get(s48Task.id)?.lastRunStatus).toBe("skipped");
      expect(store.scheduledTasks.get(s48Task.id)?.lastTurnId).toBeNull();
      expect(store.scheduledTasks.get(s48Task.id)?.lastError).toContain("Removed from the chat queue");

      // S49 + S57: Private Connect projection advertises editable: false AND queue.edit refuses editing a scheduled-task item!
      const s49ItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: conv.id,
        itemId: s49ItemId,
        content: "Desktop scheduled prompt",
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        modelSelection: providerNativeModelSelection({ providerId: "pi", modelId: "provider-default" }),
        attribution: {
          scheduledTask: {
            taskId: s48Task.id,
            runId: randomUUID(),
            title: s48Task.title,
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });
      const pcProjection = projectPrivateConnectQueue(store, conv, { isActive: false, waitingForLocalAction: false });
      expect(pcProjection.items.find((entry) => entry.id === s49ItemId)?.editable).toBe(false);
      const pcEditRes = await handlePrivateConnectQueueCommand(
        store,
        {
          deviceId: "dev-1",
          sessionId: "sess-1",
          scopes: ["view", "prompt"],
          projectIds: [project.id],
          grants: [],
          grantVersion: 1,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        conv,
        {
          type: "queue.edit",
          requestId: randomUUID(),
          conversationId: conv.id,
          id: s49ItemId,
          expectedRevision: 0,
          content: "Tampered prompt",
        },
      );
      expect(pcEditRes.ok).toBe(false);
      if (!pcEditRes.ok) expect(pcEditRes.code).toBe("forbidden");
      store.orchestration.queue.cancel({ conversationId: conv.id, itemId: s49ItemId, reason: "withdrawn" });

      // S50: Deleting a task withdraws a BLOCKED scheduled queue item even after the occurrence was failed & untracked!
      const s50Task = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Blocked then deleted",
        prompt: "Blocked prompt",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
        nextRunAt: "2026-11-27T13:00:00.000Z",
        now: "2026-11-27T12:00:00.000Z",
      });
      const s50RunId = randomUUID();
      store.scheduledTasks.claimRun({
        runId: s50RunId,
        taskId: s50Task.id,
        claimKey: `manual:${s50Task.id}:${s50RunId}`,
        trigger: "manual",
        scheduledFor: null,
        claimedAt: "2026-11-27T12:00:00.000Z",
        nextRunAtAfterClaim: "2026-11-27T13:00:00.000Z",
      });
      const s50ItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: conv.id,
        itemId: s50ItemId,
        content: "Blocked prompt",
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        attribution: {
          scheduledTask: {
            taskId: s50Task.id,
            runId: s50RunId,
            title: s50Task.title,
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });
      store.orchestration.queue.block({ conversationId: conv.id, itemId: s50ItemId, blockedReason: "dispatch-failed", detail: "Provider error" });
      store.scheduledTasks.updateRun(s50RunId, { state: "failed", error: "Provider error", finishedAt: "2026-11-27T12:01:00.000Z", updatedAt: "2026-11-27T12:01:00.000Z" });
      const s50Broadcasts: unknown[] = [];
      const s50CancelListener = vi.fn();
      const unsubS50 = store.orchestration.queue.onCancel(s50CancelListener);
      const s50Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => conv,
        broadcast: (event) => s50Broadcasts.push(event),
      });
      // S62 + S67: let real queue.cancel withdrawal SUCCEED inside delete transaction, then fail repository.delete ->
      // SQLite rolls back BOTH queue withdrawal and task row, AND zero cancel-listener or broadcast notifications fire!
      const deleteSpy = vi.spyOn(store.scheduledTasks, "delete").mockImplementationOnce(() => {
        throw new Error("Simulated SQLite delete failure after withdraw");
      });
      expect(() => s50Service.delete(s50Task.id)).toThrow("Simulated SQLite delete failure after withdraw");
      deleteSpy.mockRestore();
      expect(store.scheduledTasks.get(s50Task.id)).not.toBeNull();
      expect(store.orchestration.queue.getItem(s50ItemId)?.state).toBe("blocked");
      expect(s50CancelListener).not.toHaveBeenCalled();
      expect(s50Broadcasts).toHaveLength(0);

      // Retry succeeds atomically: both blocked item is cancelled, task is deleted, and listener/broadcast fire AFTER commit.
      s50Service.delete(s50Task.id);
      unsubS50();
      expect(store.scheduledTasks.get(s50Task.id)).toBeNull();
      expect(store.orchestration.queue.getItem(s50ItemId)?.state).toBe("cancelled");
      expect(s50CancelListener).toHaveBeenCalledTimes(1);
      expect(s50Broadcasts.length).toBeGreaterThanOrEqual(1);

      // S51: Stale claim withdrawal after async prep marks progressed=true so a second unheld waiting item wakes immediately!
      const s51Conv = store.createConversation(project.id, "S51 two-item chat");
      const s51Task1 = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Stale head",
        prompt: "First stale",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: s51Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
        nextRunAt: "2026-11-27T13:00:00.000Z",
        now: "2026-11-27T12:00:00.000Z",
      });
      const s51Run1Id = randomUUID();
      store.scheduledTasks.claimRun({
        runId: s51Run1Id,
        taskId: s51Task1.id,
        claimKey: `manual:${s51Task1.id}:${s51Run1Id}`,
        trigger: "manual",
        scheduledFor: null,
        claimedAt: "2026-11-27T12:00:00.000Z",
        nextRunAtAfterClaim: "2026-11-27T13:00:00.000Z",
      });
      const s51Dispatched: string[] = [];
      let s51PrepOnce = true;
      const s51Deps = {
        ...dummyDeps,
        verifyProviderInstallation: async () => {
          if (s51PrepOnce) {
            s51PrepOnce = false;
            store.scheduledTasks.delete(s51Task1.id);
          }
        },
        turns: {
          ...dummyDeps.turns,
          acquireTurnAdmission: async () => ({ conversationId: s51Conv.id, token: Symbol("adm"), release: vi.fn() }),
          queue: (req: { content: string }) => {
            s51Dispatched.push(req.content);
            const begun = store.beginAgentTurn({
              id: randomUUID(),
              conversationId: s51Conv.id,
              runId: `run-${randomUUID()}`,
              content: req.content,
              activateConversation: false,
              providerId: s51Conv.providerId,
              harnessId: s51Conv.modelSelection.harnessId,
              backendProfileId: s51Conv.modelSelection.backendProfileId,
              model: s51Conv.modelSelection.modelId,
              modelAlias: s51Conv.modelSelection.alias,
              reasoningEffort: s51Conv.modelSelection.reasoningEffort ?? "",
              interactionMode: s51Conv.interactionMode,
              accessMode: s51Conv.accessMode,
              providerSessionBefore: null,
              usageAtStart: null,
              configurationRevision: s51Conv.modelSelection.backendConfigurationRevision,
              association: "authoritative",
            });
            return { message: begun.message, turn: begun.turn };
          },
        },
      } as unknown as TurnInteractionCommandDependencies;
      const s51Runtime = createQueuedMessageRuntime(s51Deps, {
        signal: new AbortController().signal,
        track: (fn) => fn(),
      });
      await s51Runtime.start();
      const s51Item1 = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: s51Conv.id,
        itemId: s51Item1,
        content: "First stale",
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        attribution: {
          scheduledTask: {
            taskId: s51Task1.id,
            runId: s51Run1Id,
            title: s51Task1.title,
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });
      const s51Task2 = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Second live occurrence",
        prompt: "Second valid item",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: s51Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
        nextRunAt: "2026-11-27T13:00:00.000Z",
        now: "2026-11-27T12:00:00.000Z",
      });
      const s51Run2Id = randomUUID();
      store.scheduledTasks.claimRun({
        runId: s51Run2Id,
        taskId: s51Task2.id,
        claimKey: `manual:${s51Task2.id}:${s51Run2Id}`,
        trigger: "manual",
        scheduledFor: null,
        claimedAt: "2026-11-27T12:00:01.000Z",
        nextRunAtAfterClaim: "2026-11-27T13:00:00.000Z",
      });
      const s51Item2 = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: s51Conv.id,
        itemId: s51Item2,
        content: "Second valid item",
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        attribution: {
          scheduledTask: {
            taskId: s51Task2.id,
            runId: s51Run2Id,
            title: s51Task2.title,
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });
      store.scheduledTasks.updateRun(s51Run2Id, {
        state: "queued",
        conversationId: s51Conv.id,
        queueItemId: s51Item2,
        updatedAt: "2026-11-27T12:00:02.000Z",
      });
      await s51Runtime.schedule(s51Conv.id);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(store.orchestration.queue.getItem(s51Item1)?.state).toBe("cancelled");
      expect(s51Dispatched).toEqual(["Second valid item"]);

      // S53: promote_to_steer rechecks locked content after lease.ready when item was edited to a slash command mid-wait!
      const s53Parent = store.createConversation(project.id, "S53 Parent");
      const s53Child = store.createConversation(project.id, "S53 Child");
      const s53ParentTurn = store.beginAgentTurn({
        id: randomUUID(),
        conversationId: s53Parent.id,
        runId: `run-${randomUUID()}`,
        content: "Manage child",
        activateConversation: false,
        providerId: s53Parent.providerId,
        harnessId: s53Parent.modelSelection.harnessId,
        backendProfileId: s53Parent.modelSelection.backendProfileId,
        model: s53Parent.modelSelection.modelId,
        modelAlias: s53Parent.modelSelection.alias,
        reasoningEffort: s53Parent.modelSelection.reasoningEffort ?? "",
        interactionMode: s53Parent.interactionMode,
        accessMode: s53Parent.accessMode,
        providerSessionBefore: null,
        usageAtStart: null,
        configurationRevision: s53Parent.modelSelection.backendConfigurationRevision,
        association: "authoritative",
      }).turn;
      store.agentThreadManagement.attachManaged({
        childConversationId: s53Child.id,
        sourceConversationId: s53Parent.id,
        sourceTurnId: s53ParentTurn.id,
        sourceRunId: s53ParentTurn.runId,
        sourceHarnessId: s53Parent.modelSelection.harnessId,
        now: "2026-11-27T12:00:00.000Z",
      });
      // S53 + S60 + S64: stored order [A, delegated-results, /cmd] vs delivery order [A, /cmd, delegated-results],
      // plus dispatching barrier — cover BOTH pre-lease and post-claim slash-command fallbacks!
      const s53OrdinaryId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: s53Child.id,
        itemId: s53OrdinaryId,
        content: "Ordinary item A",
        kind: "message",
        createdBy: "user",
        creationSource: "web",
        requestedAt: "2026-11-27T12:00:01.000Z",
      });
      const s53ItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: s53Child.id,
        itemId: s53ItemId,
        content: "Regular follow-up",
        kind: "message",
        createdBy: "agent",
        creationSource: "mcp",
        requestedAt: "2026-11-27T12:00:02.000Z",
      });
      const s53DelegatedId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: s53Child.id,
        itemId: s53DelegatedId,
        content: "Delegated child summary",
        kind: "delegated-results",
        createdBy: "system",
        creationSource: "server",
        requestedAt: "2026-11-27T12:00:03.000Z",
        attribution: {
          delegatedCompletion: {
            parentConversationId: s53Child.id,
            generation: 1,
            taskIds: ["a".repeat(64)],
          },
        },
      });
      // Reorder s53ItemId to the end so stored order is [A, delegated-results, s53ItemId] while timestamp order is A < s53ItemId < delegated!
      store.orchestration.queue.reorder({ conversationId: s53Child.id, itemId: s53ItemId, beforeItemId: null });
      const steerSpy = vi.fn();
      const s53Res = await executeManagedQueueMutation(
        {
          store,
          turns: {
            isActive: (id: string) => id === s53Child.id,
            activeIdentity: () => ({ turnId: "active-turn", runId: "active-run" }),
            acquireFollowUpAdmission: () => ({
              conversationId: s53Child.id,
              turnId: "active-turn",
              runId: "active-run",
              ready: Promise.resolve().then(() => {
                // Edit queued item to a slash command WHILE lease.ready is pending!
                store.orchestration.queue.edit({
                  conversationId: s53Child.id,
                  itemId: s53ItemId,
                  expectedRevision: 0,
                  content: "/context",
                });
              }),
              release: vi.fn(),
            }),
            steer: steerSpy,
          } as never,
          broadcastConversationShell: vi.fn(),
          broadcastSnapshot: vi.fn(),
          broadcast: vi.fn(),
          now: () => "2026-11-27T12:00:00.000Z",
        } as never,
        s53Parent,
        s53Child,
        { conversationId: s53Child.id, action: "promote_to_steer", itemId: s53ItemId },
        randomUUID(),
        new AbortController().signal,
      );
      expect(steerSpy).not.toHaveBeenCalled();
      const s53Parsed = JSON.parse(s53Res.text) as { disposition: string; movedFirst: boolean; message: string };
      expect(s53Parsed.disposition).toBe("queued");
      expect(s53Parsed.movedFirst).toBe(false);
      expect(s53Parsed.message).toContain("Commands must run as a separate turn.");
      expect(store.orchestration.queue.getItem(s53ItemId)?.state).toBe("waiting");
      expect(store.orchestration.queue.getState(s53Child.id)?.activeItemIds).toEqual([
        s53OrdinaryId,
        s53DelegatedId,
        s53ItemId,
      ]);
      // Now test the PRE-LEASE fallback with stored order [A, delegated-results, /context] AND with a dispatching barrier!
      const s64PreLeaseRes = await executeManagedQueueMutation(
        {
          store,
          turns: {
            isActive: (id: string) => id === s53Child.id,
            activeIdentity: () => ({ turnId: "active-turn", runId: "active-run" }),
            acquireFollowUpAdmission: vi.fn(),
            steer: steerSpy,
          } as never,
          broadcastConversationShell: vi.fn(),
          broadcastSnapshot: vi.fn(),
          broadcast: vi.fn(),
          now: () => "2026-11-27T12:00:00.000Z",
        } as never,
        s53Parent,
        s53Child,
        { conversationId: s53Child.id, action: "promote_to_steer", itemId: s53ItemId },
        randomUUID(),
        new AbortController().signal,
      );
      const s64PreLeaseParsed = JSON.parse(s64PreLeaseRes.text) as { disposition: string; movedFirst: boolean };
      expect(s64PreLeaseParsed.disposition).toBe("queued");
      expect(s64PreLeaseParsed.movedFirst).toBe(false);
      expect(store.orchestration.queue.getState(s53Child.id)?.activeItemIds).toEqual([
        s53OrdinaryId,
        s53DelegatedId,
        s53ItemId,
      ]);
      // Dispatching barrier test (pre-lease AND post-claim): [A, dispatchingItem, /cmd2] -> /cmd2 must NOT cross dispatchingItem and movedFirst must be false!
      const s64DispConv = store.createConversation(project.id, "S64 Dispatching barrier");
      store.agentThreadManagement.attachManaged({
        childConversationId: s64DispConv.id,
        sourceConversationId: s53Parent.id,
        sourceTurnId: s53ParentTurn.id,
        sourceRunId: s53ParentTurn.runId,
        sourceHarnessId: s53Parent.modelSelection.harnessId,
        now: "2026-11-27T12:00:00.000Z",
      });
      const s64A = randomUUID();
      const s64Disp = randomUUID();
      const s64Cmd = randomUUID();
      store.orchestration.queue.enqueue({ conversationId: s64DispConv.id, itemId: s64A, content: "Item A", kind: "message", createdBy: "user", creationSource: "web" });
      store.orchestration.queue.enqueue({ conversationId: s64DispConv.id, itemId: s64Disp, content: "Dispatching B", kind: "message", createdBy: "user", creationSource: "web" });
      store.orchestration.queue.enqueue({ conversationId: s64DispConv.id, itemId: s64Cmd, content: "/compact", kind: "message", createdBy: "agent", creationSource: "mcp" });
      store.orchestration.queue.claim({ conversationId: s64DispConv.id, itemId: s64Disp, mode: "run" });
      const s64BarrierRes = await executeManagedQueueMutation(
        {
          store,
          turns: {
            isActive: (id: string) => id === s64DispConv.id,
            activeIdentity: () => ({ turnId: "active-turn", runId: "active-run" }),
            acquireFollowUpAdmission: vi.fn(),
            steer: steerSpy,
          } as never,
          broadcastConversationShell: vi.fn(),
          broadcastSnapshot: vi.fn(),
          broadcast: vi.fn(),
          now: () => "2026-11-27T12:00:00.000Z",
        } as never,
        s53Parent,
        s64DispConv,
        { conversationId: s64DispConv.id, action: "promote_to_steer", itemId: s64Cmd },
        randomUUID(),
        new AbortController().signal,
      );
      const s64BarrierParsed = JSON.parse(s64BarrierRes.text) as { disposition: string; movedFirst: boolean };
      expect(s64BarrierParsed.disposition).toBe("queued");
      expect(s64BarrierParsed.movedFirst).toBe(false);
      expect(store.orchestration.queue.getState(s64DispConv.id)?.activeItemIds).toEqual([s64A, s64Disp, s64Cmd]);

      // S73: Post-claim dispatching barrier — ordinary item edited to slash command during admission stays behind dispatching item with movedFirst: false!
      const s73PostDispCmd = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: s64DispConv.id,
        itemId: s73PostDispCmd,
        content: "Ordinary prompt edited during admission",
        kind: "message",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const s73PostDispRes = await executeManagedQueueMutation(
        {
          store,
          turns: {
            isActive: (id: string) => id === s64DispConv.id,
            activeIdentity: () => ({ turnId: "active-turn", runId: "active-run" }),
            acquireFollowUpAdmission: () => ({
              conversationId: s64DispConv.id,
              turnId: "active-turn",
              runId: "active-run",
              ready: Promise.resolve().then(() => {
                store.orchestration.queue.edit({
                  conversationId: s64DispConv.id,
                  itemId: s73PostDispCmd,
                  expectedRevision: 0,
                  content: "/compact",
                });
              }),
              release: vi.fn(),
            }),
            steer: steerSpy,
          } as never,
          broadcastConversationShell: vi.fn(),
          broadcastSnapshot: vi.fn(),
          broadcast: vi.fn(),
          now: () => "2026-11-27T12:00:00.000Z",
        } as never,
        s53Parent,
        s64DispConv,
        { conversationId: s64DispConv.id, action: "promote_to_steer", itemId: s73PostDispCmd },
        randomUUID(),
        new AbortController().signal,
      );
      const s73PostDispParsed = JSON.parse(s73PostDispRes.text) as { disposition: string; movedFirst: boolean };
      expect(s73PostDispParsed.disposition).toBe("queued");
      expect(s73PostDispParsed.movedFirst).toBe(false);
      expect(store.orchestration.queue.getItem(s73PostDispCmd)?.state).toBe("waiting");
      expect(store.orchestration.queue.getState(s64DispConv.id)?.activeItemIds).toEqual([
        s64A,
        s64Disp,
        s73PostDispCmd,
        s64Cmd,
      ]);

      // S61: Boot requeue updates scheduled_task_runs + scheduled_tasks atomically and rolls back both if the second write fails!
      const s61Conv = store.createConversation(project.id, "S61 Rollback");
      const s61Task = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Atomic boot requeue",
        prompt: "Run atomic",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: s61Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
        nextRunAt: "2026-11-27T13:00:00.000Z",
        now: "2026-11-27T12:00:00.000Z",
      });
      const s61RunId = randomUUID();
      store.scheduledTasks.claimRun({
        runId: s61RunId,
        taskId: s61Task.id,
        claimKey: `manual:${s61Task.id}:${s61RunId}`,
        trigger: "manual",
        scheduledFor: null,
        claimedAt: "2026-11-27T12:00:00.000Z",
        nextRunAtAfterClaim: "2026-11-27T13:00:00.000Z",
      });
      const s61ItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: s61Conv.id,
        itemId: s61ItemId,
        content: s61Task.prompt,
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        attribution: {
          scheduledTask: {
            taskId: s61Task.id,
            runId: s61RunId,
            title: s61Task.title,
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });
      const s61TurnId = randomUUID();
      store.scheduledTasks.updateRun(s61RunId, { state: "running", conversationId: s61Conv.id, queueItemId: s61ItemId, turnId: s61TurnId, updatedAt: "2026-11-27T12:00:02.000Z" });
      store.scheduledTasks.update(s61Task.id, { now: "2026-11-27T12:00:02.000Z", lastRunStatus: "running", lastTurnId: s61TurnId });
      const s61UpdateSpy = vi.spyOn(store.scheduledTasks, "update").mockImplementationOnce(() => {
        throw new Error("Simulated summary update failure");
      });
      const s61Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s61Conv,
        broadcast: () => undefined,
        enableProviders: false,
      });
      expect(() => s61Service.start()).toThrow("Simulated summary update failure");
      s61UpdateSpy.mockRestore();
      // Both rows rolled back together — occurrence stayed running instead of drifting from summary!
      expect(store.scheduledTasks.getRun(s61RunId)?.state).toBe("running");
      expect(store.scheduledTasks.get(s61Task.id)?.lastRunStatus).toBe("running");

      // S54: Historical queue.item-claimed (mode: 'steer') on a scheduled item still replays under rebuildProjections()!
      const s54Conv = store.createConversation(project.id, "S54 Replay");
      const s54ItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: s54Conv.id,
        itemId: s54ItemId,
        content: "Historical scheduled item",
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        attribution: {
          scheduledTask: {
            taskId: s48Task.id,
            runId: randomUUID(),
            title: s48Task.title,
            interactionMode: "build",
            accessMode: "supervised",
          },
        },
      });
      // Simulate a historical steer claim event already stored in orchestration_v2_events before S42 landed.
      store.orchestration.events.commit({
        actorId: "runtime",
        commandId: `hist-steer-${randomUUID()}`,
        commandType: "queue.claim",
        threadId: s54Conv.id,
        projectId: project.id,
        command: { type: "queue.claim", itemId: s54ItemId, mode: "steer" },
        expectedRevision: store.orchestration.events.revision(s54Conv.id),
        events: [{ type: "queue.item-claimed", payload: { itemId: s54ItemId, mode: "steer", dispatchOrdinal: 1 } }],
        result: { itemId: s54ItemId, dispatchOrdinal: 1 },
      });
      expect(() => store.orchestration.events.rebuildProjections()).not.toThrow();
      expect(store.orchestration.queue.getItem(s54ItemId)?.state).toBe("dispatching");

      // S74: Queueing another occurrence after a failed turn clears stale lastTurnId and lastError!
      const s74Conv = store.createConversation(project.id, "S74 Clear stale failure");
      const s74Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s74Conv,
        broadcast: () => undefined,
        enableProviders: true,
      });
      const s74Task = s74Service.create({
        projectId: project.id,
        title: "Retry after failure",
        prompt: "Check again",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: s74Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const priorFailedTurnId = randomUUID();
      store.scheduledTasks.recordTaskOutcome(s74Task.id, {
        lastRunAt: s48NowIso,
        lastRunStatus: "failed",
        lastConversationId: s74Conv.id,
        lastTurnId: priorFailedTurnId,
        lastError: "Prior scheduled run failed",
        consecutiveFailures: 1,
        updatedAt: s48NowIso,
      });
      const beforeRequeue = store.scheduledTasks.get(s74Task.id);
      expect(beforeRequeue?.lastRunStatus).toBe("failed");
      expect(beforeRequeue?.lastTurnId).toBe(priorFailedTurnId);
      expect(beforeRequeue?.lastError).toBe("Prior scheduled run failed");
      const s74RunResult = await s74Service.runNow(s74Task.id);
      expect(s74RunResult.task.lastRunStatus).toBe("queued");
      expect(s74RunResult.task.lastTurnId).toBeNull();
      expect(s74RunResult.task.lastError).toBeNull();
      const s74Persisted = store.scheduledTasks.get(s74Task.id);
      expect(s74Persisted?.lastRunStatus).toBe("queued");
      expect(s74Persisted?.lastTurnId).toBeNull();
      expect(s74Persisted?.lastError).toBeNull();
    } finally {
      store.close();
    }
  });
});
