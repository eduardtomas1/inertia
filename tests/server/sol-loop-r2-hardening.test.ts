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
import { PrivateConnectRuntimeGateway } from "../../src/server/private-connect/runtime-gateway";
import { sendMessageCommand, QUEUE_ATTRIBUTION_STALE_CODE } from "../../src/server/runtime/commands/message-send-command";
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

      // S43: childQuestionWake claimed while live, then child request resolves DURING async prep -> final admission withdraws claim!
      const reqId = randomUUID();
      const childRunId = `run-${randomUUID()}`;
      const childTurnId = randomUUID();
      pendingInputs.set(reqId, {
        id: reqId,
        conversationId: child.id,
        turnId: childTurnId,
        runId: childRunId,
        kind: "question",
        questions: [{ id: "q1", header: "Q", question: "Proceed?", options: [{ label: "Yes", description: "Go" }] }],
        createdAt: "2026-11-27T12:00:00.000Z",
      } as unknown as AgentInputRequest);
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
        pendingInputs.delete(reqId);
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
});
