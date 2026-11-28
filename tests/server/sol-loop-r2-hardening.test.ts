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
import { runAuditedPrivateConnectMutation } from "../../src/main/private-connect/audit";
import { handlePrivateConnectQueueCommand, projectPrivateConnectQueue } from "../../src/server/private-connect/queue-gateway";
import { handlePrivateConnectScheduledTaskRequest } from "../../src/server/private-connect/scheduled-tasks-gateway";
import { PrivateConnectRuntimeGateway } from "../../src/server/private-connect/runtime-gateway";
import { sendMessageCommand, QUEUE_ATTRIBUTION_STALE_CODE } from "../../src/server/runtime/commands/message-send-command";
import { executeManagedQueueMutation } from "../../src/server/runtime/managed-queue-tools";
import { registerPendingInteraction } from "../../src/server/runtime/pending-interaction-registry";
import { reconcileQueueOnBoot } from "../../src/server/runtime/queue-boot-reconciliation";
import { createScheduledTaskRuntime, resolveScheduledTaskEffectiveModelSelection } from "../../src/server/runtime/scheduled-tasks/scheduled-task-runtime";
import { ScheduledTaskService } from "../../src/server/runtime/scheduled-tasks/scheduled-task-service";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-types";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import { dispatchSettledTurnOwners } from "../../src/server/runtime/turns/turn-settled-orchestration";
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
      s61Service.dispose();
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

      // S76: Running recurring task edited to a one-shot schedule that queues a newer occurrence ->
      // older turn's failure must NOT overwrite the newer occurrence's queued summary!
      let s76NowMs = Date.parse("2030-06-01T10:00:00.000Z");
      const s76Conv = store.createConversation(project.id, "S76 Latest occurrence guard");
      const s76Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s76Conv,
        broadcast: () => undefined,
        enableProviders: true,
        now: () => new Date(s76NowMs),
      });
      const s76Task = s76Service.create({
        projectId: project.id,
        title: "Recurring edited to once",
        prompt: "Check status",
        schedule: { type: "interval", everyMs: 600_000 },
        boundConversationId: s76Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const olderRun = await s76Service.runNow(s76Task.id);
      const olderTurnId = randomUUID();
      s76Service.bindRunTurn(olderRun.run.id, olderTurnId);
      expect(store.scheduledTasks.get(s76Task.id)?.lastRunStatus).toBe("running");
      expect(store.scheduledTasks.get(s76Task.id)?.lastTurnId).toBe(olderTurnId);

      // Edit the running recurring task into a one-shot schedule due in 2 minutes, then let it fire!
      s76NowMs += 60_000;
      const onceDueIso = new Date(s76NowMs + 60_000).toISOString();
      s76Service.update(s76Task.id, { schedule: { type: "once", runAt: onceDueIso }, enabled: true });
      s76NowMs += 60_000;
      await s76Service.tick();
      const s76Runs = store.scheduledTasks.listRuns(s76Task.id);
      expect(s76Runs).toHaveLength(2);
      const newerRun = s76Runs[0]!;
      expect(newerRun.id).not.toBe(olderRun.run.id);
      expect(newerRun.state).toBe("queued");
      expect(store.scheduledTasks.get(s76Task.id)?.lastRunStatus).toBe("queued");
      expect(store.scheduledTasks.get(s76Task.id)?.lastTurnId).toBeNull();
      expect(store.scheduledTasks.get(s76Task.id)?.lastError).toBeNull();

      // Now the OLDER turn fails -> history records older run as failed, but task summary stays on the newer queued run!
      s76NowMs += 10_000;
      s76Service.onTurnSettled({
        id: olderTurnId,
        conversationId: s76Conv.id,
        status: "failed",
        terminalReason: "Older recurring turn failed",
        completedAt: new Date(s76NowMs).toISOString(),
        updatedAt: new Date(s76NowMs).toISOString(),
      });
      expect(store.scheduledTasks.getRun(olderRun.run.id)?.state).toBe("failed");
      const s76SummaryAfterOlderFailure = store.scheduledTasks.get(s76Task.id);
      expect(s76SummaryAfterOlderFailure?.lastRunStatus).toBe("queued");
      expect(s76SummaryAfterOlderFailure?.lastTurnId).toBeNull();
      expect(s76SummaryAfterOlderFailure?.lastError).toBeNull();

      // S77: One-shot occurrence completing >24h after claim still transitions summary from running -> completed!
      let s77NowMs = Date.parse("2030-07-01T10:00:00.000Z");
      const s77Conv = store.createConversation(project.id, "S77 Late completion");
      const s77Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s77Conv,
        broadcast: () => undefined,
        enableProviders: true,
        now: () => new Date(s77NowMs),
      });
      const s77Task = s77Service.create({
        projectId: project.id,
        title: "Long one-shot job",
        prompt: "Run migration audit",
        schedule: { type: "once", runAt: "2030-07-01T10:05:00.000Z" },
        boundConversationId: s77Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      s77NowMs = Date.parse("2030-07-01T10:05:00.000Z");
      await s77Service.tick();
      const s77Run = store.scheduledTasks.listRuns(s77Task.id)[0]!;
      const s77TurnId = randomUUID();
      s77Service.bindRunTurn(s77Run.id, s77TurnId);
      expect(store.scheduledTasks.get(s77Task.id)?.lastRunStatus).toBe("running");

      // Advance >24 hours past claim and complete the turn.
      s77NowMs += 25 * 60 * 60 * 1_000;
      const s77DoneIso = new Date(s77NowMs).toISOString();
      s77Service.onTurnSettled({
        id: s77TurnId,
        conversationId: s77Conv.id,
        status: "completed",
        terminalReason: null,
        completedAt: s77DoneIso,
        updatedAt: s77DoneIso,
      });
      expect(store.scheduledTasks.getRun(s77Run.id)?.state).toBe("completed");
      const s77Summary = store.scheduledTasks.get(s77Task.id);
      expect(s77Summary?.lastRunStatus).toBe("completed");
      expect(s77Summary?.lastTurnId).toBe(s77TurnId);
      expect(s77Summary?.lastError).toBeNull();
      expect(s77Summary?.consecutiveFailures).toBe(0);

      // S78: Turn settlement commits run + task summary in ONE transaction; an injected failure on recordTaskOutcome
      // rolls back the run state too so replay settles both cleanly!
      const s78Conv = store.createConversation(project.id, "S78 Atomic settlement");
      const s78Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s78Conv,
        broadcast: () => undefined,
        enableProviders: true,
      });
      const s78Task = s78Service.create({
        projectId: project.id,
        title: "Atomic turn settle",
        prompt: "Check build",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: s78Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const s78Run = await s78Service.runNow(s78Task.id);
      const s78TurnId = randomUUID();
      s78Service.bindRunTurn(s78Run.run.id, s78TurnId);
      const s78OutcomeSpy = vi.spyOn(store.scheduledTasks, "recordTaskOutcome").mockImplementationOnce(() => {
        throw new Error("Simulated SQLite summary failure");
      });
      expect(() => s78Service.onTurnSettled({
        id: s78TurnId,
        conversationId: s78Conv.id,
        status: "completed",
        terminalReason: null,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })).toThrow("Simulated SQLite summary failure");
      s78OutcomeSpy.mockRestore();
      // Both rows rolled back together — run is still running, NOT drifted to completed!
      expect(store.scheduledTasks.getRun(s78Run.run.id)?.state).toBe("running");
      expect(store.scheduledTasks.get(s78Task.id)?.lastRunStatus).toBe("running");
      // Replay now settles BOTH cleanly!
      s78Service.onTurnSettled({
        id: s78TurnId,
        conversationId: s78Conv.id,
        status: "completed",
        terminalReason: null,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(store.scheduledTasks.getRun(s78Run.run.id)?.state).toBe("completed");
      expect(store.scheduledTasks.get(s78Task.id)?.lastRunStatus).toBe("completed");

      // S79: Editing prompt and target while a fresh-session run creates its chat dispatches from the consistent
      // pre-edit snapshot AND does NOT overwrite the user's newly saved target!
      const s79EditedTargetConv = store.createConversation(project.id, "S79 User edited target");
      const s79CreatedFreshConv = store.createConversation(project.id, "S79 Created fresh chat");
      let resolveCreateChat!: () => void;
      const createChatGate = new Promise<void>((resolve) => { resolveCreateChat = resolve; });
      const s79Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => {
          await createChatGate;
          return s79CreatedFreshConv;
        },
        broadcast: () => undefined,
        enableProviders: true,
      });
      const s79Task = s79Service.create({
        projectId: project.id,
        title: "Fresh session race",
        prompt: "Original prompt v1",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: null,
        freshSession: true,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const s79RunPromise = s79Service.runNow(s79Task.id);
      await Promise.resolve();
      // While createConversation is pending, user edits prompt AND binds task to a different chat!
      s79Service.update(s79Task.id, {
        prompt: "Updated prompt v2",
        boundConversationId: s79EditedTargetConv.id,
        freshSession: false,
      });
      resolveCreateChat();
      const s79Result = await s79RunPromise;
      expect(s79Result.conversationId).toBe(s79CreatedFreshConv.id);
      // Queued message in the created chat must contain the consistent v1 prompt, NOT v2!
      const s79QueuedItem = store.orchestration.queue.listActive(s79CreatedFreshConv.id)[0]!;
      expect(store.orchestration.queue.getContent(s79CreatedFreshConv.id, s79QueuedItem.id)?.content).toBe("Original prompt v1");
      // Saved target must remain the user's edited target, NOT overwritten with s79CreatedFreshConv.id!
      expect(store.scheduledTasks.get(s79Task.id)?.boundConversationId).toBe(s79EditedTargetConv.id);
      expect(store.scheduledTasks.get(s79Task.id)?.prompt).toBe("Updated prompt v2");

      // S80: Boot recovery for a missed one-shot persists a skipped run row so an older queued recurring run
      // completing later cannot overwrite the missed-boot skip summary!
      let s80NowMs = Date.parse("2030-08-01T10:00:00.000Z");
      const s80Conv = store.createConversation(project.id, "S80 Missed boot run");
      const s80FirstService = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s80Conv,
        broadcast: () => undefined,
        enableProviders: true,
        now: () => new Date(s80NowMs),
      });
      const s80Task = s80FirstService.create({
        projectId: project.id,
        title: "Missed boot vs older run",
        prompt: "Check logs",
        schedule: { type: "interval", everyMs: 600_000 },
        boundConversationId: s80Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const s80OlderRun = await s80FirstService.runNow(s80Task.id);
      // Edit task to a one-shot due at 10:05, then restart app at 10:10 (past the one-shot time!).
      s80FirstService.update(s80Task.id, {
        schedule: { type: "once", runAt: "2030-08-01T10:05:00.000Z" },
        enabled: true,
      });
      s80NowMs = Date.parse("2030-08-01T10:10:00.000Z");
      const s80BootService = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s80Conv,
        broadcast: () => undefined,
        enableProviders: true,
        now: () => new Date(s80NowMs),
      });
      s80BootService.start();
      try {
        const s80AfterBoot = store.scheduledTasks.get(s80Task.id)!;
        expect(s80AfterBoot.enabled).toBe(false);
        expect(s80AfterBoot.lastRunStatus).toBe("skipped");
        expect(store.scheduledTasks.listRuns(s80Task.id)[0]?.state).toBe("skipped");
        // Now the older queued recurring run starts and completes -> must NOT overwrite the missed-boot skip!
        const s80OlderTurnId = randomUUID();
        s80BootService.bindRunTurn(s80OlderRun.run.id, s80OlderTurnId);
        s80BootService.onTurnSettled({
          id: s80OlderTurnId,
          conversationId: s80Conv.id,
          status: "completed",
          terminalReason: null,
          completedAt: new Date(s80NowMs + 5_000).toISOString(),
          updatedAt: new Date(s80NowMs + 5_000).toISOString(),
        });
        expect(store.scheduledTasks.getRun(s80OlderRun.run.id)?.state).toBe("completed");
        expect(store.scheduledTasks.get(s80Task.id)?.lastRunStatus).toBe("skipped");
      } finally {
        s80BootService.dispose();
      }

      // S81: Backward clock adjustment still grants summary ownership to the newer durable claim (rowid DESC)!
      let s81NowMs = Date.parse("2030-09-01T12:00:00.000Z");
      const s81Conv = store.createConversation(project.id, "S81 Backward clock");
      const s81Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s81Conv,
        broadcast: () => undefined,
        enableProviders: true,
        now: () => new Date(s81NowMs),
      });
      const s81Task = s81Service.create({
        projectId: project.id,
        title: "Clock jump test",
        prompt: "Verify clock resilience",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: s81Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const s81First = await s81Service.runNow(s81Task.id);
      const s81Turn1 = randomUUID();
      s81Service.bindRunTurn(s81First.run.id, s81Turn1);
      s81Service.onTurnSettled({
        id: s81Turn1,
        conversationId: s81Conv.id,
        status: "completed",
        terminalReason: null,
        completedAt: new Date(s81NowMs + 1_000).toISOString(),
        updatedAt: new Date(s81NowMs + 1_000).toISOString(),
      });
      // Jump wall clock BACKWARD by 1 hour before claiming and completing run 2!
      s81NowMs -= 3_600_000;
      const s81Second = await s81Service.runNow(s81Task.id);
      const s81Turn2 = randomUUID();
      s81Service.bindRunTurn(s81Second.run.id, s81Turn2);
      s81Service.onTurnSettled({
        id: s81Turn2,
        conversationId: s81Conv.id,
        status: "completed",
        terminalReason: null,
        completedAt: new Date(s81NowMs + 1_000).toISOString(),
        updatedAt: new Date(s81NowMs + 1_000).toISOString(),
      });
      expect(store.scheduledTasks.listRuns(s81Task.id)[0]?.id).toBe(s81Second.run.id);
      expect(store.scheduledTasks.get(s81Task.id)?.lastRunStatus).toBe("completed");
      expect(store.scheduledTasks.get(s81Task.id)?.lastTurnId).toBe(s81Turn2);
    } finally {
      store.close();
    }
  });

  it("S83–S86: retries failed turn settlement via runtime callback, advances duplicate claims, preserves active runs during pruning, and isolates/retries failed boot recovery", async () => {
    const { store, workspace } = createTempStore();
    try {
      const project = store.createProject("S83-S86 Project", workspace);

      // S83: Transient recordTaskOutcome failure inside dispatchSettledTurnOwners rolls back,
      // then scheduler-owned retry keyed by turnId settles run + summary so Run now works!
      vi.useFakeTimers();
      const s83Conv = store.createConversation(project.id, "S83 Settlement retry");
      const s83Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s83Conv,
        broadcast: () => undefined,
        enableProviders: true,
      });
      const s83Task = s83Service.create({
        projectId: project.id,
        title: "Retryable settlement",
        prompt: "Check CI",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: s83Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const s83Run = await s83Service.runNow(s83Task.id);
      const s83TurnId = randomUUID();
      s83Service.bindRunTurn(s83Run.run.id, s83TurnId);
      const s83Spy = vi.spyOn(store.scheduledTasks, "recordTaskOutcome").mockImplementationOnce(() => {
        throw new Error("Transient SQLite busy");
      });
      const settledTurn = {
        id: s83TurnId,
        conversationId: s83Conv.id,
        status: "completed",
        terminalReason: null,
        completedAt: "2030-10-01T10:01:00.000Z",
        updatedAt: "2030-10-01T10:01:00.000Z",
      };
      await expect(dispatchSettledTurnOwners(settledTurn as never, [
        (settled) => s83Service.onTurnSettled(settled),
      ])).rejects.toThrow("Required turn follow-up did not finish.");
      s83Spy.mockRestore();
      expect(store.scheduledTasks.getRun(s83Run.run.id)?.state).toBe("running");
      expect(store.scheduledTasks.get(s83Task.id)?.lastRunStatus).toBe("running");

      // Advance retry timer -> scheduler-owned retry commits completed on run + task summary!
      await vi.advanceTimersByTimeAsync(500);
      expect(store.scheduledTasks.getRun(s83Run.run.id)?.state).toBe("completed");
      expect(store.scheduledTasks.get(s83Task.id)?.lastRunStatus).toBe("completed");
      // Subsequent Run now succeeds instead of being blocked by a stuck running row!
      const s83FollowUp = await s83Service.runNow(s83Task.id);
      expect(s83FollowUp.run.state).toBe("queued");
      s83Service.dispose();
      vi.useRealTimers();

      // S84: Duplicate claim after clock rollback + pause/resume advances nextRunAt instead of spinning at 0ms!
      const localTenAm = new Date(2030, 9, 10, 10, 0, 0, 0);
      let s84NowMs = localTenAm.getTime() - 60_000;
      const s84Conv = store.createConversation(project.id, "S84 Duplicate claim");
      const s84Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s84Conv,
        broadcast: () => undefined,
        enableProviders: true,
        now: () => new Date(s84NowMs),
      });
      const s84Daily = s84Service.create({
        projectId: project.id,
        title: "Daily 10am",
        prompt: "Morning summary",
        schedule: { type: "fixed_time", timeOfDay: "10:00", weekdays: undefined },
        boundConversationId: s84Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const firstDueIso = s84Daily.nextRunAt!;
      expect(Date.parse(firstDueIso)).toBe(localTenAm.getTime());
      s84NowMs = localTenAm.getTime();
      await s84Service.tick();
      const s84Run1 = store.scheduledTasks.listRuns(s84Daily.id)[0]!;
      const s84Turn1 = randomUUID();
      s84Service.bindRunTurn(s84Run1.id, s84Turn1);
      s84Service.onTurnSettled({
        id: s84Turn1,
        conversationId: s84Conv.id,
        status: "completed",
        terminalReason: null,
        completedAt: new Date(s84NowMs + 1_000).toISOString(),
        updatedAt: new Date(s84NowMs + 1_000).toISOString(),
      });
      // Roll clock backward before 10:00, pause + resume -> nextRunAt recomputes to the already-consumed 10:00!
      s84NowMs = localTenAm.getTime() - 600_000;
      s84Service.update(s84Daily.id, { enabled: false });
      const resumedDaily = s84Service.update(s84Daily.id, { enabled: true });
      expect(resumedDaily.nextRunAt).toBe(firstDueIso);
      // Advance back to 10:00 and tick -> duplicate claim must NOT enqueue a second run AND must advance nextRunAt!
      s84NowMs = localTenAm.getTime();
      await s84Service.tick();
      expect(store.scheduledTasks.listRuns(s84Daily.id)).toHaveLength(1);
      const afterDupDaily = store.scheduledTasks.get(s84Daily.id)!;
      expect(Date.parse(afterDupDaily.nextRunAt!)).toBeGreaterThan(localTenAm.getTime());
      expect(store.scheduledTasks.listDue(new Date(s84NowMs).toISOString(), 25).some((t) => t.id === s84Daily.id)).toBe(false);
      // Same duplicate-claim guard for a consumed one-shot schedule -> disables consumed one-shot!
      const s84OnceAt = new Date(localTenAm.getTime() + 120_000).toISOString();
      const s84Once = s84Service.create({
        projectId: project.id,
        title: "One-shot duplicate",
        prompt: "Once only",
        schedule: { type: "once", runAt: s84OnceAt },
        boundConversationId: s84Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      s84NowMs = Date.parse(s84OnceAt);
      await s84Service.tick();
      expect(store.scheduledTasks.listRuns(s84Once.id)).toHaveLength(1);
      // Roll clock back and re-enable same one-shot timestamp -> duplicate claim disables it cleanly!
      s84NowMs = Date.parse(s84OnceAt) - 60_000;
      s84Service.update(s84Once.id, { enabled: true, schedule: { type: "once", runAt: s84OnceAt } });
      s84NowMs = Date.parse(s84OnceAt);
      await s84Service.tick();
      expect(store.scheduledTasks.listRuns(s84Once.id)).toHaveLength(1);
      expect(store.scheduledTasks.get(s84Once.id)?.enabled).toBe(false);
      expect(store.scheduledTasks.get(s84Once.id)?.nextRunAt).toBeNull();
      s84Service.dispose();

      // S85: 30 newer terminal claims on the same task must NOT prune an older active queued run!
      const s85Conv = store.createConversation(project.id, "S85 Active pruning guard");
      const s85Task = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Active run vs terminal history",
        prompt: "Keep active",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: s85Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
        nextRunAt: "2030-11-01T10:01:00.000Z",
        now: "2030-11-01T10:00:00.000Z",
      });
      const activeRunId = randomUUID();
      store.scheduledTasks.claimRun({
        runId: activeRunId,
        taskId: s85Task.id,
        claimKey: `active:${activeRunId}`,
        trigger: "manual",
        scheduledFor: null,
        claimedAt: "2030-11-01T10:00:00.000Z",
        nextRunAtAfterClaim: "2030-11-01T10:01:00.000Z",
      });
      store.scheduledTasks.updateRun(activeRunId, {
        state: "queued",
        conversationId: s85Conv.id,
        queueItemId: randomUUID(),
        updatedAt: "2030-11-01T10:00:01.000Z",
      });
      for (let i = 0; i < 30; i += 1) {
        const missedId = randomUUID();
        const at = new Date(Date.parse("2030-11-01T10:05:00.000Z") + i * 1_000).toISOString();
        store.scheduledTasks.claimRun({
          runId: missedId,
          taskId: s85Task.id,
          claimKey: `missed:${i}:${missedId}`,
          trigger: "schedule",
          scheduledFor: at,
          claimedAt: at,
          nextRunAtAfterClaim: null,
          disableTaskAfterClaim: true,
        });
        store.scheduledTasks.updateRun(missedId, {
          state: "skipped",
          error: "Missed while closed",
          finishedAt: at,
          updatedAt: at,
        });
      }
      // Older active queued run must STILL exist!
      expect(store.scheduledTasks.getRun(activeRunId)?.state).toBe("queued");
      expect(store.scheduledTasks.hasActiveQueuedOrRunningOccurrence(s85Task.id)).toBe(true);

      // S86: Failed missed-boot transaction must NOT abort shared queue startup AND boot reconciliation retries!
      vi.useFakeTimers();
      const s86QueuedConv = store.createConversation(project.id, "S86 Pending queue conv");
      const s86ItemId = randomUUID();
      store.orchestration.queue.enqueue({
        conversationId: s86QueuedConv.id,
        itemId: s86ItemId,
        content: "Unattended automatic queued message",
        kind: "message",
        createdBy: "system",
        creationSource: "server",
        origin: "automatic",
      });
      const s86MissedTask = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Missed once with transient boot error",
        prompt: "Missed prompt",
        schedule: { type: "once", runAt: "2030-01-01T08:00:00.000Z" },
        boundConversationId: null,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
        nextRunAt: "2030-01-01T08:00:00.000Z",
        now: "2030-01-01T07:00:00.000Z",
      });
      const s86Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s86QueuedConv,
        broadcast: () => undefined,
        enableProviders: true,
        now: () => new Date("2030-01-01T09:00:00.000Z"),
      });
      const scheduledConversations: string[] = [];
      const queueRuntime = createQueuedMessageRuntime({
        store,
        enableProviders: true,
        turns: {
          isActive: () => false,
          isClosing: () => false,
          activeIdentity: () => null,
          isFinishing: () => false,
          waitForProviderCleanup: (ids: readonly string[]) => {
            scheduledConversations.push(...ids);
            return new Promise<boolean>(() => undefined);
          },
        },
        pendingApprovals: new Map(),
        pendingInputs: new Map(),
        conversationAttachments: { retain: vi.fn(), release: vi.fn() },
        broadcast: () => undefined,
        broadcastConversationShell: () => undefined,
        broadcastSnapshot: () => undefined,
        verifyProviderInstallation: async () => undefined,
      } as unknown as TurnInteractionCommandDependencies, {
        signal: new AbortController().signal,
        track: (fn) => fn(),
      });
      const s86ClaimSpy = vi.spyOn(store.scheduledTasks, "claimRun").mockImplementationOnce(() => {
        throw new Error("Transient boot SQLite lock");
      });
      await queueRuntime.start(() => { s86Service.start(); });
      s86ClaimSpy.mockRestore();
      // Shared queue startup was NOT aborted — pending conversation was scheduled!
      await vi.advanceTimersByTimeAsync(10);
      expect(scheduledConversations).toContain(s86QueuedConv.id);
      // Missed-boot reconciliation failed transiently first, then succeeded automatically on boot retry!
      await vi.advanceTimersByTimeAsync(600);
      const s86Recovered = store.scheduledTasks.get(s86MissedTask.id)!;
      expect(s86Recovered.enabled).toBe(false);
      expect(s86Recovered.lastRunStatus).toBe("skipped");
      expect(store.scheduledTasks.listRuns(s86MissedTask.id)[0]?.state).toBe("skipped");
      s86Service.dispose();
    } finally {
      vi.useRealTimers();
      store.close();
    }
  });

  it("Opus R1 (R1-A1..A4, R1-B6, R1-B8): retries bindRunTurn, purges deleted settlements, survives rescheduleTimer failure, caps settlement retries, rejects forbidden PC runNow pre-claim, and audits scheduled-task actions distinctly", async () => {
    const { store, workspace } = createTempStore();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const project = store.createProject("Opus R1 Project", workspace);
      vi.useFakeTimers();

      // R1-A1: Transient bindRunTurn failure is retried and settles an already-terminal turn!
      const a1Conv = store.createConversation(project.id, "R1-A1 Bind retry");
      const a1Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => a1Conv,
        broadcast: () => undefined,
        enableProviders: true,
      });
      const a1Task = a1Service.create({
        projectId: project.id,
        title: "Bind retry task",
        prompt: "Run bind test",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: a1Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const a1Run = await a1Service.runNow(a1Task.id);
      const a1Turn = store.beginAgentTurn({
        id: randomUUID(),
        conversationId: a1Conv.id,
        runId: `run-${randomUUID()}`,
        content: "Run bind test",
        activateConversation: false,
        providerId: a1Conv.providerId,
        harnessId: a1Conv.modelSelection.harnessId,
        backendProfileId: a1Conv.modelSelection.backendProfileId,
        model: a1Conv.modelSelection.modelId,
        modelAlias: a1Conv.modelSelection.alias,
        reasoningEffort: a1Conv.modelSelection.reasoningEffort ?? "",
        interactionMode: a1Conv.interactionMode,
        accessMode: a1Conv.accessMode,
        providerSessionBefore: null,
        usageAtStart: null,
        configurationRevision: a1Conv.modelSelection.backendConfigurationRevision,
        association: "authoritative",
      }).turn;
      const a1UpdateRunSpy = vi.spyOn(store.scheduledTasks, "updateRun").mockImplementationOnce(() => {
        throw new Error("Transient SQLITE_BUSY during bindRunTurn");
      });
      expect(() => a1Service.bindRunTurn(a1Run.run.id, a1Turn.id)).toThrow("Transient SQLITE_BUSY");
      a1UpdateRunSpy.mockRestore();
      // Turn completes while run is still unbound -> onTurnSettled cannot find it yet
      store.settleAgentTurn(a1Turn.id, { status: "completed" });
      a1Service.onTurnSettled(store.agentTurn(a1Turn.id));
      expect(store.scheduledTasks.getRun(a1Run.run.id)?.state).toBe("queued");
      // Retry timer flushes pending binding -> binds AND immediately settles the already-terminal turn!
      await vi.advanceTimersByTimeAsync(500);
      expect(store.scheduledTasks.getRun(a1Run.run.id)?.state).toBe("completed");
      expect(store.scheduledTasks.get(a1Task.id)?.lastRunStatus).toBe("completed");
      // Subsequent Run now succeeds!
      const a1Next = await a1Service.runNow(a1Task.id);
      expect(a1Next.run.state).toBe("queued");
      a1Service.dispose();

      // R1-A2 + R1-A4: Deleted task purges pending settlement, and 8 repeated failures mark run failed so task is unblocked!
      const a2Conv = store.createConversation(project.id, "R1-A2/A4 Settlement hygiene");
      const a2Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => a2Conv,
        broadcast: () => undefined,
        enableProviders: true,
      });
      const a2Task = a2Service.create({
        projectId: project.id,
        title: "Deleted pending settlement",
        prompt: "Check delete purge",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: a2Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const a2Run = await a2Service.runNow(a2Task.id);
      const a2TurnId = randomUUID();
      a2Service.bindRunTurn(a2Run.run.id, a2TurnId);
      const a2OutcomeSpy = vi.spyOn(store.scheduledTasks, "recordTaskOutcome").mockImplementation(() => {
        throw new Error("Permanent DB constraint failure");
      });
      expect(() => a2Service.onTurnSettled({
        id: a2TurnId,
        conversationId: a2Conv.id,
        status: "completed",
        terminalReason: null,
        completedAt: "2030-10-01T10:01:00.000Z",
        updatedAt: "2030-10-01T10:01:00.000Z",
      })).toThrow("Permanent DB constraint failure");
      const findSpy = vi.spyOn(store.scheduledTasks, "findRunByTurnId");
      a2Service.delete(a2Task.id);
      findSpy.mockClear();
      await a2Service.tick();
      expect(findSpy).not.toHaveBeenCalled();
      findSpy.mockRestore();

      // Now verify R1-A4 cap: after 8 failed settlement attempts, fallback marks run failed and unblocks task!
      const a4Task = a2Service.create({
        projectId: project.id,
        title: "Capped settlement retries",
        prompt: "Check retry cap",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: a2Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const a4Run = await a2Service.runNow(a4Task.id);
      const a4TurnId = randomUUID();
      a2Service.bindRunTurn(a4Run.run.id, a4TurnId);
      const a4Turn = {
        id: a4TurnId,
        conversationId: a2Conv.id,
        status: "completed" as const,
        terminalReason: null,
        completedAt: "2030-10-01T10:05:00.000Z",
        updatedAt: "2030-10-01T10:05:00.000Z",
      };
      for (let attempt = 0; attempt < 8; attempt += 1) {
        expect(() => a2Service.onTurnSettled(a4Turn)).toThrow("Permanent DB constraint failure");
      }
      a2OutcomeSpy.mockRestore();
      expect(store.scheduledTasks.getRun(a4Run.run.id)?.state).toBe("failed");
      expect(store.scheduledTasks.hasActiveQueuedOrRunningOccurrence(a4Task.id)).toBe(false);
      a2Service.dispose();

      // R1-A3: rescheduleTimer throwing inside tick() falls back to periodic tick without killing scheduler!
      const a3Broadcasts: string[] = [];
      const a3Conv = store.createConversation(project.id, "R1-A3 Timer resilience");
      const a3Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => a3Conv,
        broadcast: (ev) => {
          if (ev.type === "scheduled-tasks.changed" && ev.projectId) a3Broadcasts.push(ev.projectId);
        },
        enableProviders: true,
        now: () => new Date("2030-10-01T10:00:00.000Z"),
      });
      a3Service.start();
      const a3ListSpy = vi.spyOn(store.scheduledTasks, "list").mockImplementationOnce(() => {
        throw new Error("Transient list failure during rescheduleTimer");
      });
      await a3Service.tick();
      a3ListSpy.mockRestore();
      // Fallback 60s timer must still fire tick() cleanly!
      const tickSpy = vi.spyOn(a3Service, "tick");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(tickSpy).toHaveBeenCalled();
      tickSpy.mockRestore();
      a3Service.dispose();

      // R1-B6: Private Connect runNow on a bound chat switched to Full access rejects pre-claim as forbidden (0 run rows, 0 consecutiveFailures)!
      const b6Conv = store.createConversation(project.id, "R1-B6 Full access chat");
      store.updateConversation(b6Conv.id, { accessMode: "full" });
      const b6Runtime = createScheduledTaskRuntime({
        store,
        creation: () => undefined,
        messageQueue: () => undefined,
        broadcast: () => undefined,
        broadcastSnapshot: () => undefined,
        broadcastConversationShell: () => undefined,
        enableProviders: true,
      });
      const b6Task = b6Runtime.service.create({
        projectId: project.id,
        title: "Supervised task on full chat",
        prompt: "Check forbidden pre-claim",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: b6Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const b6Resp = await handlePrivateConnectScheduledTaskRequest(
        {
          deviceId: randomUUID(),
          scopes: ["view", "prompt"],
          projectIds: [project.id],
          grants: [{ conversationId: b6Conv.id, projectId: project.id }],
        } as never,
        { type: "scheduled-task.run-now", requestId: randomUUID(), taskId: b6Task.id },
        b6Runtime.privateConnectHandlers,
        {
          conversation: (id) => store.conversation(id),
          isConversationAuthorized: () => true,
          // Simulate race where gateway pre-check passed just before chat switched to full access:
          promptSafetyRejection: () => null,
        },
      );
      expect(b6Resp.ok).toBe(false);
      if (!b6Resp.ok) expect(b6Resp.code).toBe("forbidden");
      expect(store.scheduledTasks.listRuns(b6Task.id)).toHaveLength(0);
      expect(store.scheduledTasks.get(b6Task.id)?.consecutiveFailures).toBe(0);
      b6Runtime.dispose();

      // R1-B8: Audit trail logs distinct scheduled-task.accepted / scheduled-task.deleted types (never prompt.accepted)!
      const auditTypes: string[] = [];
      for (const req of [
        { protocolVersion: 1 as const, requestId: randomUUID(), type: "scheduled-task.toggle" as const, taskId: randomUUID(), enabled: false },
        { protocolVersion: 1 as const, requestId: randomUUID(), type: "scheduled-task.run-now" as const, taskId: randomUUID() },
        { protocolVersion: 1 as const, requestId: randomUUID(), type: "scheduled-task.delete" as const, taskId: randomUUID() },
      ]) {
        const expectedKind = req.type === "scheduled-task.toggle"
          ? "scheduled-task.updated"
          : req.type === "scheduled-task.run-now"
            ? "scheduled-task.ran"
            : "scheduled-task.deleted";
        await runAuditedPrivateConnectMutation(req, {
          record: (type) => auditTypes.push(type),
          persist: async () => undefined,
          dispatch: async () => ({ type: "response", requestId: req.requestId, ok: true, result: { kind: expectedKind } }),
        });
      }
      expect(auditTypes).toEqual([
        "request.started", "scheduled-task.accepted",
        "request.started", "scheduled-task.accepted",
        "request.started", "scheduled-task.deleted",
      ]);

      const a4Persisted = store.scheduledTasks.get(a4Task.id);
      expect(a4Persisted?.lastRunStatus).toBe("failed");
      expect(a4Persisted?.lastError).toBe("Scheduled run settlement failed repeatedly.");

      const s87Conv = store.createConversation(project.id, "S87 Lookup retry");
      const s87Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => s87Conv,
        broadcast: () => undefined,
        enableProviders: true,
      });
      const s87Task = s87Service.create({
        projectId: project.id,
        title: "Lookup retry task",
        prompt: "Check lookup retry",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: s87Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
      });
      const s87Run = await s87Service.runNow(s87Task.id);
      const s87TurnId = randomUUID();
      s87Service.bindRunTurn(s87Run.run.id, s87TurnId);
      const s87LookupSpy = vi.spyOn(store.scheduledTasks, "findRunByTurnId").mockImplementationOnce(() => {
        throw new Error("Transient SQLITE_BUSY on findRunByTurnId");
      });
      expect(() => s87Service.onTurnSettled({
        id: s87TurnId,
        conversationId: s87Conv.id,
        status: "completed",
        terminalReason: null,
        completedAt: "2030-10-01T10:10:00.000Z",
        updatedAt: "2030-10-01T10:10:00.000Z",
      })).toThrow("Transient SQLITE_BUSY on findRunByTurnId");
      s87LookupSpy.mockRestore();
      expect(store.scheduledTasks.getRun(s87Run.run.id)?.state).toBe("running");
      await vi.advanceTimersByTimeAsync(500);
      expect(store.scheduledTasks.getRun(s87Run.run.id)?.state).toBe("completed");
      expect(store.scheduledTasks.get(s87Task.id)?.lastRunStatus).toBe("completed");
      s87Service.dispose();

      let r2NowMs = Date.parse("2030-12-01T10:00:00.000Z");
      const r2Conv = store.createConversation(project.id, "R2-A1/S90 Boot backoff and cutoff");
      const r2DueShortlyIso = new Date(r2NowMs + 100).toISOString();
      const r2OnceTask = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: project.id,
        title: "Due 100ms after first start",
        prompt: "Run shortly after boot",
        schedule: { type: "once", runAt: r2DueShortlyIso },
        boundConversationId: r2Conv.id,
        freshSession: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: null,
        nextRunAt: r2DueShortlyIso,
        now: new Date(r2NowMs - 60_000).toISOString(),
      });
      const r2BootService = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => r2Conv,
        broadcast: () => undefined,
        enableProviders: true,
        now: () => new Date(r2NowMs),
      });
      let bootFailCount = 0;
      const r2ListSpy = vi.spyOn(store.scheduledTasks, "listActiveRuns").mockImplementation(() => {
        if (bootFailCount < 2) {
          bootFailCount += 1;
          throw new Error(`Transient boot error ${bootFailCount}`);
        }
        return [];
      });
      expect(() => r2BootService.start()).toThrow("Transient boot error 1");
      r2NowMs += 500;
      await vi.advanceTimersByTimeAsync(500);
      expect(bootFailCount).toBe(2);
      r2NowMs += 500;
      await vi.advanceTimersByTimeAsync(500);
      expect(bootFailCount).toBe(2);
      expect(store.scheduledTasks.get(r2OnceTask.id)?.enabled).toBe(true);
      r2NowMs += 500;
      await vi.advanceTimersByTimeAsync(500);
      r2ListSpy.mockRestore();
      const r2AfterBoot = store.scheduledTasks.get(r2OnceTask.id)!;
      expect(r2AfterBoot.enabled).toBe(true);
      expect(r2AfterBoot.lastRunStatus).toBeNull();
      r2BootService.dispose();

      let r2a3BroadcastCalls = 0;
      const r2a3Service = new ScheduledTaskService({
        repository: store.scheduledTasks,
        store,
        createConversation: async () => r2Conv,
        broadcast: () => {
          r2a3BroadcastCalls += 1;
          throw new Error("Observer broadcast boom");
        },
        enableProviders: true,
        now: () => new Date("2030-12-01T10:05:00.000Z"),
      });
      expect(() => r2a3Service.start()).not.toThrow();
      expect(r2a3BroadcastCalls).toBeGreaterThanOrEqual(1);
      r2a3Service.dispose();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
      store.close();
    }
  });
});
