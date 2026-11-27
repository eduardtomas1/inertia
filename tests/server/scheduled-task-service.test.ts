// @inertia-test-suite portable

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import type {
  AgentTurn,
  ClientCommand,
  Conversation,
  Project,
  RuntimeMutationEvent,
  ServerEvent,
} from "../../src/shared/contracts";
import type { QueueItemProjection } from "../../src/shared/orchestration-queue";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  SCHEDULED_TASK_FAILURE_TRACKING_WINDOW_MS,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskPatch,
  type ScheduledTaskRun,
  type ScheduledTaskRunStatus,
  type ScheduledTaskRunTrigger,
} from "../../src/shared/scheduled-tasks";
import { RecordNotFoundError } from "../../src/server/persistence/errors";
import { RuntimeRequestError, USER_CORRECTABLE_REQUEST } from "../../src/server/runtime-errors";
import { createScheduledTaskCommandHandler } from "../../src/server/runtime/commands/scheduled-task-commands";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import {
  SCHEDULED_TASK_MISSED_BOOT_ERROR,
  ScheduledTaskService,
  type ScheduledTaskEnqueuePromptInput,
  type ScheduledTaskRepositoryLike,
  type ScheduledTaskStoreLike,
} from "../../src/server/runtime/scheduled-tasks/scheduled-task-service";
import { hold, release, UPDATE_HOLD_MESSAGE } from "../../src/server/runtime/update-hold";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";

const PROJECT_ID = "proj-1";
const OTHER_PROJECT_ID = "proj-2";

const MODEL_SELECTION = modelSelectionSchema.parse(
  providerNativeModelSelection({
    providerId: "codex",
    modelId: "gpt-5.4",
    reasoningEffort: "medium",
  }),
);

class InMemoryScheduledTaskRepository implements ScheduledTaskRepositoryLike {
  readonly tasks = new Map<string, ScheduledTask>();
  readonly runs = new Map<string, ScheduledTaskRun>();
  private readonly claimKeys = new Set<string>();
  archivedConversationIds = new Set<string>();

  list(projectId?: string): ScheduledTask[] {
    const items = [...this.tasks.values()];
    return projectId ? items.filter((task) => task.projectId === projectId) : items;
  }

  get(taskId: string): ScheduledTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  create(
    input: ScheduledTaskCreateInput & { id: string; nextRunAt: string | null; now: string },
  ): ScheduledTask {
    const task: ScheduledTask = {
      id: input.id,
      projectId: input.projectId,
      title: input.title,
      prompt: input.prompt,
      schedule: input.schedule,
      boundConversationId: input.boundConversationId ?? null,
      freshSession: input.freshSession ?? false,
      modelSelection: input.modelSelection ?? null,
      interactionMode: input.interactionMode ?? "build",
      accessMode: input.accessMode ?? "supervised",
      enabled: input.enabled ?? true,
      nextRunAt: input.nextRunAt,
      lastRunAt: null,
      lastRunStatus: null,
      lastConversationId: null,
      lastTurnId: null,
      lastError: null,
      consecutiveFailures: 0,
      createdBy: input.createdBy ?? "user",
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.tasks.set(task.id, task);
    return { ...task };
  }

  update(
    taskId: string,
    patch: ScheduledTaskPatch & {
      nextRunAt?: string | null;
      now: string;
      lastError?: string | null;
      consecutiveFailures?: number;
      lastRunAt?: string | null;
      lastRunStatus?: ScheduledTaskRunStatus | null;
      lastConversationId?: string | null;
      lastTurnId?: string | null;
    },
  ): ScheduledTask {
    const existing = this.tasks.get(taskId);
    if (!existing) throw new RecordNotFoundError(`Scheduled task ${taskId} not found.`);
    const updated: ScheduledTask = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.boundConversationId !== undefined ? { boundConversationId: patch.boundConversationId } : {}),
      ...(patch.freshSession !== undefined ? { freshSession: patch.freshSession } : {}),
      ...(patch.modelSelection !== undefined ? { modelSelection: patch.modelSelection } : {}),
      ...(patch.interactionMode !== undefined ? { interactionMode: patch.interactionMode } : {}),
      ...(patch.accessMode !== undefined ? { accessMode: patch.accessMode } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      ...(patch.consecutiveFailures !== undefined ? { consecutiveFailures: patch.consecutiveFailures } : {}),
      ...(patch.lastRunAt !== undefined ? { lastRunAt: patch.lastRunAt } : {}),
      ...(patch.lastRunStatus !== undefined ? { lastRunStatus: patch.lastRunStatus } : {}),
      ...(patch.lastConversationId !== undefined ? { lastConversationId: patch.lastConversationId } : {}),
      ...(patch.lastTurnId !== undefined ? { lastTurnId: patch.lastTurnId } : {}),
      updatedAt: patch.now,
    };
    this.tasks.set(taskId, updated);
    return { ...updated };
  }

  delete(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }

  listDue(nowIso: string, limit = 25): ScheduledTask[] {
    const nowMs = Date.parse(nowIso);
    return [...this.tasks.values()]
      .filter((task) => task.enabled && task.nextRunAt !== null && Date.parse(task.nextRunAt) <= nowMs)
      .sort((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? "", "en"))
      .slice(0, limit)
      .map((task) => ({ ...task }));
  }

  listRuns(taskId: string, limit = 25): ScheduledTaskRun[] {
    return [...this.runs.values()]
      .filter((run) => run.taskId === taskId)
      .sort((left, right) => right.claimedAt.localeCompare(left.claimedAt, "en"))
      .slice(0, limit)
      .map((run) => ({ ...run }));
  }

  listActiveRuns(): ScheduledTaskRun[] {
    return [...this.runs.values()]
      .filter((run) => run.state === "claimed" || run.state === "queued" || run.state === "running")
      .sort((left, right) => left.claimedAt.localeCompare(right.claimedAt, "en"))
      .map((run) => ({ ...run }));
  }

  getRun(runId: string): ScheduledTaskRun | null {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  findRunByTurnId(turnId: string): ScheduledTaskRun | null {
    for (const run of this.runs.values()) {
      if (run.turnId === turnId) return { ...run };
    }
    return null;
  }

  hasActiveQueuedOrRunningOccurrence(taskId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.taskId === taskId && (run.state === "claimed" || run.state === "queued" || run.state === "running")) {
        return true;
      }
    }
    return false;
  }

  claimRun(input: {
    runId: string;
    taskId: string;
    claimKey: string;
    trigger: ScheduledTaskRunTrigger;
    scheduledFor: string | null;
    claimedAt: string;
    nextRunAtAfterClaim: string | null;
    disableTaskAfterClaim?: boolean;
  }): ScheduledTaskRun | null {
    if (this.claimKeys.has(input.claimKey)) return null;
    const task = this.tasks.get(input.taskId);
    if (!task) return null;
    this.claimKeys.add(input.claimKey);
    const run: ScheduledTaskRun = {
      id: input.runId,
      taskId: input.taskId,
      claimKey: input.claimKey,
      trigger: input.trigger,
      scheduledFor: input.scheduledFor,
      state: "claimed",
      conversationId: null,
      turnId: null,
      queueItemId: null,
      error: null,
      claimedAt: input.claimedAt,
      finishedAt: null,
    };
    this.runs.set(run.id, run);
    this.tasks.set(task.id, {
      ...task,
      nextRunAt: input.nextRunAtAfterClaim,
      ...(input.disableTaskAfterClaim ? { enabled: false } : {}),
      updatedAt: input.claimedAt,
    });
    return { ...run };
  }

  updateRun(
    runId: string,
    patch: {
      state?: ScheduledTaskRunStatus;
      conversationId?: string | null;
      turnId?: string | null;
      queueItemId?: string | null;
      error?: string | null;
      finishedAt?: string | null;
      updatedAt: string;
    },
  ): ScheduledTaskRun | null {
    const existing = this.runs.get(runId);
    if (!existing) return null;
    const updated: ScheduledTaskRun = {
      ...existing,
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.conversationId !== undefined ? { conversationId: patch.conversationId } : {}),
      ...(patch.turnId !== undefined ? { turnId: patch.turnId } : {}),
      ...(patch.queueItemId !== undefined ? { queueItemId: patch.queueItemId } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    };
    this.runs.set(runId, updated);
    return { ...updated };
  }

  recordTaskOutcome(
    taskId: string,
    outcome: {
      lastRunAt: string;
      lastRunStatus: ScheduledTaskRunStatus;
      lastConversationId?: string | null;
      lastTurnId?: string | null;
      lastError: string | null;
      consecutiveFailures: number;
      updatedAt: string;
    },
  ): ScheduledTask | null {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    const updated: ScheduledTask = {
      ...existing,
      lastRunAt: outcome.lastRunAt,
      lastRunStatus: outcome.lastRunStatus,
      ...(outcome.lastConversationId !== undefined ? { lastConversationId: outcome.lastConversationId } : {}),
      ...(outcome.lastTurnId !== undefined ? { lastTurnId: outcome.lastTurnId } : {}),
      lastError: outcome.lastError,
      consecutiveFailures: outcome.consecutiveFailures,
      updatedAt: outcome.updatedAt,
    };
    this.tasks.set(taskId, updated);
    return { ...updated };
  }

  reconcileStrandedRuns(nowIso: string, errorMessage: string): ScheduledTaskRun[] {
    const reconciled: ScheduledTaskRun[] = [];
    for (const run of this.runs.values()) {
      if (run.state === "claimed") {
        const updated: ScheduledTaskRun = {
          ...run,
          state: "failed",
          error: errorMessage,
          finishedAt: nowIso,
        };
        this.runs.set(run.id, updated);
        reconciled.push({ ...updated });
      }
    }
    return reconciled;
  }

  disableTasksForMissingOrArchivedTarget(nowIso: string): string[] {
    const disabled: string[] = [];
    for (const task of this.tasks.values()) {
      if (task.enabled && task.boundConversationId && this.archivedConversationIds.has(task.boundConversationId)) {
        this.tasks.set(task.id, {
          ...task,
          enabled: false,
          nextRunAt: null,
          updatedAt: nowIso,
        });
        disabled.push(task.id);
      }
    }
    return disabled;
  }
}

function createHarness(initialIso = "2026-05-10T10:00:00.000Z") {
  let currentMs = Date.parse(initialIso);
  const repository = new InMemoryScheduledTaskRepository();
  const projects = new Map<string, Pick<Project, "id" | "name">>([
    [PROJECT_ID, { id: PROJECT_ID, name: "Alpha" }],
    [OTHER_PROJECT_ID, { id: OTHER_PROJECT_ID, name: "Beta" }],
  ]);
  const conversations = new Map<
    string,
    Pick<Conversation, "id" | "projectId" | "title" | "archivedAt" | "accessMode" | "interactionMode" | "modelSelection">
  >();
  const addConversation = (
    overrides: Partial<Pick<Conversation, "id" | "projectId" | "title" | "archivedAt" | "accessMode" | "interactionMode" | "modelSelection">> = {},
  ) => {
    const id = overrides.id ?? randomUUID();
    const conv = {
      id,
      projectId: overrides.projectId ?? PROJECT_ID,
      title: overrides.title ?? "Thread",
      archivedAt: overrides.archivedAt ?? null,
      accessMode: overrides.accessMode ?? "supervised" as const,
      interactionMode: overrides.interactionMode ?? "build" as const,
      modelSelection: overrides.modelSelection ?? MODEL_SELECTION,
    };
    conversations.set(id, conv);
    return conv;
  };

  const store: ScheduledTaskStoreLike = {
    project(projectId) {
      const found = projects.get(projectId);
      if (!found) throw new RecordNotFoundError(`Project ${projectId} not found.`);
      return found;
    },
    conversation(conversationId) {
      const found = conversations.get(conversationId);
      if (!found) throw new RecordNotFoundError(`Conversation ${conversationId} not found.`);
      return found;
    },
  };

  const broadcasts: RuntimeMutationEvent[] = [];
  const dispatched: ScheduledTaskEnqueuePromptInput[] = [];
  const resetCalls: string[] = [];
  const createdConversationIds: string[] = [];
  let enqueueDelay: (() => Promise<void>) | null = null;
  let nextTurnIdForEnqueue: string | null = null;

  const service = new ScheduledTaskService({
    repository,
    store,
    now: () => new Date(currentMs),
    broadcast: (event) => {
      broadcasts.push(event);
    },
    createConversation: async (input) => {
      const conv = addConversation({
        projectId: input.projectId,
        title: input.title,
        accessMode: input.accessMode,
        interactionMode: input.interactionMode,
        modelSelection: input.modelSelection ?? MODEL_SELECTION,
      });
      createdConversationIds.push(conv.id);
      return conv;
    },
    resetConversationSession: async (conversationId) => {
      resetCalls.push(conversationId);
    },
    enqueueScheduledPrompt: async (input) => {
      if (enqueueDelay) await enqueueDelay();
      dispatched.push(input);
      const turnId = nextTurnIdForEnqueue;
      nextTurnIdForEnqueue = null;
      return { queueItemId: input.queueItemId, ...(turnId ? { turnId } : {}) };
    },
  });

  return {
    service,
    repository,
    conversations,
    addConversation,
    broadcasts,
    dispatched,
    resetCalls,
    createdConversationIds,
    setNow(iso: string) {
      currentMs = Date.parse(iso);
    },
    advanceMs(ms: number) {
      currentMs += ms;
    },
    setEnqueueDelay(fn: (() => Promise<void>) | null) {
      enqueueDelay = fn;
    },
    setNextTurnId(turnId: string | null) {
      nextTurnIdForEnqueue = turnId;
    },
  };
}

afterEach(() => {
  release();
  return cleanupTurnControllerTestDirectories();
});

describe("ScheduledTaskService", () => {
  it("validates interval, fixed_time, and once creation including past once rejection", () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();

    const intervalTask = h.service.create({
      projectId: PROJECT_ID,
      title: "Heartbeat",
      prompt: "Check repo status",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: conv.id,
    });
    expect(intervalTask.nextRunAt).toBe("2026-05-10T10:01:00.000Z");

    const fixedTask = h.service.create({
      projectId: PROJECT_ID,
      title: "Morning digest",
      prompt: "Summarize PRs",
      schedule: { type: "fixed_time", timeOfDay: "09:30", weekdays: [1, 3, 5] },
    });
    expect(fixedTask.nextRunAt).not.toBeNull();

    const onceFuture = h.service.create({
      projectId: PROJECT_ID,
      title: "One-off release check",
      prompt: "Verify build artifacts",
      schedule: { type: "once", runAt: "2026-05-10T12:00:00.000Z" },
    });
    expect(onceFuture.nextRunAt).toBe("2026-05-10T12:00:00.000Z");

    // Past once schedule rejected on create
    expect(() => h.service.create({
      projectId: PROJECT_ID,
      title: "Past once",
      prompt: "Too late",
      schedule: { type: "once", runAt: "2026-05-10T09:59:00.000Z" },
    })).toThrow(RuntimeRequestError);

    // Missing project rejected
    expect(() => h.service.create({
      projectId: "missing-project",
      title: "Orphan",
      prompt: "Hello",
      schedule: { type: "interval", everyMs: 60_000 },
    })).toThrow(RuntimeRequestError);

    // Wrong project or archived bound conversation rejected
    const otherConv = h.addConversation({ projectId: OTHER_PROJECT_ID });
    expect(() => h.service.create({
      projectId: PROJECT_ID,
      title: "Cross-project",
      prompt: "Nope",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: otherConv.id,
    })).toThrow(RuntimeRequestError);

    const archivedConv = h.addConversation({ archivedAt: "2026-05-09T00:00:00.000Z" });
    try {
      h.service.create({
        projectId: PROJECT_ID,
        title: "Archived target",
        prompt: "Nope",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: archivedConv.id,
      });
      expect.unreachable("should have rejected archived conversation");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeRequestError);
      expect((error as RuntimeRequestError).code).toBe(USER_CORRECTABLE_REQUEST);
    }
  });

  it("enforces atomic duplicate claim rejection and bracketed in-flight reservation", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();
    const task = h.service.create({
      projectId: PROJECT_ID,
      title: "Poll CI",
      prompt: "Check workflow",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: conv.id,
    });

    // Duplicate claimKey rejected atomically by repository
    const claimed = h.repository.claimRun({
      runId: randomUUID(),
      taskId: task.id,
      claimKey: `sched:${task.id}:${task.nextRunAt}`,
      trigger: "schedule",
      scheduledFor: task.nextRunAt,
      claimedAt: "2026-05-10T10:01:00.000Z",
      nextRunAtAfterClaim: "2026-05-10T10:02:00.000Z",
    });
    expect(claimed).not.toBeNull();
    const duplicate = h.repository.claimRun({
      runId: randomUUID(),
      taskId: task.id,
      claimKey: `sched:${task.id}:${task.nextRunAt}`,
      trigger: "schedule",
      scheduledFor: task.nextRunAt,
      claimedAt: "2026-05-10T10:01:00.000Z",
      nextRunAtAfterClaim: "2026-05-10T10:02:00.000Z",
    });
    expect(duplicate).toBeNull();

    // Mark the manual-seeded run completed so we can test concurrent runNow bracketed reservation
    h.repository.updateRun(claimed!.id, {
      state: "completed",
      finishedAt: "2026-05-10T10:01:05.000Z",
      updatedAt: "2026-05-10T10:01:05.000Z",
    });

    let releaseEnqueue!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    h.setEnqueueDelay(() => gate);

    const firstRun = h.service.runNow(task.id);
    await expect(h.service.runNow(task.id)).rejects.toThrow(/already starting/i);

    releaseEnqueue();
    const result = await firstRun;
    expect(result.run.state).toBe("queued");
    expect(h.dispatched).toHaveLength(1);
  });

  it("enforces max 1 queued/running occurrence for recurring tasks without piling up runs", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();
    const task = h.service.create({
      projectId: PROJECT_ID,
      title: "Recurring check",
      prompt: "Inspect build",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: conv.id,
    });

    // First due tick fires
    h.setNow("2026-05-10T10:01:00.000Z");
    await h.service.tick();
    expect(h.dispatched).toHaveLength(1);
    expect(h.repository.listRuns(task.id)).toHaveLength(1);
    expect(h.repository.get(task.id)?.nextRunAt).toBe("2026-05-10T10:02:00.000Z");

    // Second due tick while first run is still queued skips firing and advances nextRunAt
    h.setNow("2026-05-10T10:02:00.000Z");
    await h.service.tick();
    expect(h.dispatched).toHaveLength(1);
    expect(h.repository.listRuns(task.id)).toHaveLength(1);
    expect(h.repository.get(task.id)?.nextRunAt).toBe("2026-05-10T10:03:00.000Z");

    // Manual runNow while queued fails with clear busy error
    await expect(h.service.runNow(task.id)).rejects.toThrow(/active queued or running/i);
  });

  it("auto-disables one-shot tasks on claim so they fire at most once", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();
    const task = h.service.create({
      projectId: PROJECT_ID,
      title: "Deploy reminder",
      prompt: "Check prod metrics",
      schedule: { type: "once", runAt: "2026-05-10T10:05:00.000Z" },
      boundConversationId: conv.id,
    });

    h.setNow("2026-05-10T10:05:00.000Z");
    await h.service.tick();

    const after = h.repository.get(task.id)!;
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(h.dispatched).toHaveLength(1);

    // Subsequent ticks do not re-fire
    h.setNow("2026-05-10T10:10:00.000Z");
    await h.service.tick();
    expect(h.dispatched).toHaveLength(1);
  });

  it("handles bound, bound+freshSession, unbound+freshSession, and unbound+new-per-run thread modes", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");

    // 1) Bound + freshSession: reuses conversation, does NOT prematurely reset session at enqueue, sets freshContext: true
    const boundConv = h.addConversation();
    const boundFresh = h.service.create({
      projectId: PROJECT_ID,
      title: "Bound fresh",
      prompt: "Audit logs",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: boundConv.id,
      freshSession: true,
    });
    const r1 = await h.service.runNow(boundFresh.id);
    expect(r1.conversationId).toBe(boundConv.id);
    expect(h.resetCalls).toEqual([]);
    expect(h.dispatched[0]?.freshContext).toBe(true);

    // 2) Unbound + freshSession: first run creates conversation and binds it; second run reuses with freshContext: true
    const unboundFresh = h.service.create({
      projectId: PROJECT_ID,
      title: "Dedicated fresh",
      prompt: "Daily report",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: null,
      freshSession: true,
    });
    const r2a = await h.service.runNow(unboundFresh.id);
    expect(h.repository.get(unboundFresh.id)?.boundConversationId).toBe(r2a.conversationId);
    expect(h.dispatched[1]?.freshContext).toBe(true);

    // Bind turn and finish first run so second run can execute
    h.service.bindRunTurn(r2a.run.id, "turn-2a");
    h.service.onTurnSettled({
      id: "turn-2a",
      conversationId: r2a.conversationId,
      status: "completed",
      terminalReason: null,
      completedAt: "2026-05-10T10:00:10.000Z",
      updatedAt: "2026-05-10T10:00:10.000Z",
    });

    const r2b = await h.service.runNow(unboundFresh.id);
    expect(r2b.conversationId).toBe(r2a.conversationId);
    expect(h.resetCalls).toEqual([]);
    expect(h.dispatched[2]?.freshContext).toBe(true);

    // 3) Unbound + freshSession=false: creates a fresh conversation on every run
    const perRun = h.service.create({
      projectId: PROJECT_ID,
      title: "New chat per run",
      prompt: "Run sweep",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: null,
      freshSession: false,
    });
    const r3a = await h.service.runNow(perRun.id);
    h.service.bindRunTurn(r3a.run.id, "turn-3a");
    h.service.onTurnSettled({
      id: "turn-3a",
      conversationId: r3a.conversationId,
      status: "completed",
      terminalReason: null,
      completedAt: "2026-05-10T10:00:20.000Z",
      updatedAt: "2026-05-10T10:00:20.000Z",
    });
    const r3b = await h.service.runNow(perRun.id);
    expect(r3b.conversationId).not.toBe(r3a.conversationId);
    expect(h.repository.get(perRun.id)?.boundConversationId).toBeNull();
  });

  it("disables task and fails run cleanly when bound conversation is archived before fire", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();
    const task = h.service.create({
      projectId: PROJECT_ID,
      title: "Bound task",
      prompt: "Ping",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: conv.id,
    });

    // Archive conversation after task creation
    h.conversations.set(conv.id, { ...conv, archivedAt: "2026-05-10T10:00:30.000Z" });
    h.setNow("2026-05-10T10:01:00.000Z");
    await h.service.tick();

    const after = h.repository.get(task.id)!;
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(after.lastRunStatus).toBe("failed");
    expect(h.repository.listRuns(task.id)[0]?.state).toBe("failed");
  });

  it("sets followsThreadSelection when modelSelection is null and applies withAgentSenderNote cleanly", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();

    const followTask = h.service.create({
      projectId: PROJECT_ID,
      title: "Follow thread model",
      prompt: "Check tests",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: conv.id,
      modelSelection: null,
    });
    await h.service.runNow(followTask.id);
    expect(h.dispatched[0]?.followsThreadSelection).toBe(true);
    expect(h.dispatched[0]?.modelSelection).toBeNull();
    expect(h.dispatched[0]?.content).toBe("Check tests");
    expect(h.dispatched[0]?.providerContent).toContain("[Inertia: scheduled task \"Follow thread model\"");
    expect(h.dispatched[0]?.providerContent).toContain("Check tests");

    const pinnedTask = h.service.create({
      projectId: PROJECT_ID,
      title: "Slash command task",
      prompt: "/review staged changes",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: conv.id,
      modelSelection: MODEL_SELECTION,
    });
    await h.service.runNow(pinnedTask.id);
    expect(h.dispatched[1]?.followsThreadSelection).toBe(false);
    expect(h.dispatched[1]?.modelSelection).toEqual(MODEL_SELECTION);
    // Leading slash command stays verbatim in providerContent
    expect(h.dispatched[1]?.providerContent).toBe("/review staged changes");
    expect(h.dispatched[1]?.content).toBe("/review staged changes");
  });

  it("tracks consecutive failures within 24h, resets on completion, and ignores outcomes past 24h", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();
    const task = h.service.create({
      projectId: PROJECT_ID,
      title: "Flaky check",
      prompt: "Run e2e",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: conv.id,
    });

    // Run 1 fails
    h.setNextTurnId("turn-1");
    await h.service.runNow(task.id);
    h.advanceMs(30_000);
    h.service.onTurnSettled({
      id: "turn-1",
      conversationId: conv.id,
      status: "failed",
      terminalReason: "Provider exited with code 1",
      completedAt: "2026-05-10T10:00:30.000Z",
      updatedAt: "2026-05-10T10:00:30.000Z",
    });
    expect(h.repository.get(task.id)?.consecutiveFailures).toBe(1);
    expect(h.repository.get(task.id)?.lastError).toBe("Provider exited with code 1");
    expect(h.repository.get(task.id)?.lastRunStatus).toBe("failed");

    // Run 2 fails -> consecutiveFailures = 2
    h.setNextTurnId("turn-2");
    await h.service.runNow(task.id);
    h.advanceMs(30_000);
    h.service.onTurnSettled({
      id: "turn-2",
      conversationId: conv.id,
      status: "interrupted",
      terminalReason: "Interrupted by timeout",
      completedAt: "2026-05-10T10:01:00.000Z",
      updatedAt: "2026-05-10T10:01:00.000Z",
    });
    expect(h.repository.get(task.id)?.consecutiveFailures).toBe(2);

    // Run 3 succeeds -> resets consecutiveFailures to 0 and clears lastError
    h.setNextTurnId("turn-3");
    await h.service.runNow(task.id);
    h.advanceMs(30_000);
    h.service.onTurnSettled({
      id: "turn-3",
      conversationId: conv.id,
      status: "completed",
      terminalReason: null,
      completedAt: "2026-05-10T10:01:30.000Z",
      updatedAt: "2026-05-10T10:01:30.000Z",
    });
    expect(h.repository.get(task.id)?.consecutiveFailures).toBe(0);
    expect(h.repository.get(task.id)?.lastError).toBeNull();
    expect(h.repository.get(task.id)?.lastRunStatus).toBe("completed");

    // Run 4 settles AFTER 24h window -> run marked failed, but task failure counter stays untouched
    h.setNextTurnId("turn-4");
    const run4 = await h.service.runNow(task.id);
    h.advanceMs(SCHEDULED_TASK_FAILURE_TRACKING_WINDOW_MS + 60_000);
    h.service.onTurnSettled({
      id: "turn-4",
      conversationId: conv.id,
      status: "failed",
      terminalReason: "Late failure after 24h",
      completedAt: new Date(Date.parse("2026-05-10T10:01:30.000Z") + SCHEDULED_TASK_FAILURE_TRACKING_WINDOW_MS + 60_000).toISOString(),
      updatedAt: new Date(Date.parse("2026-05-10T10:01:30.000Z") + SCHEDULED_TASK_FAILURE_TRACKING_WINDOW_MS + 60_000).toISOString(),
    });
    expect(h.repository.getRun(run4.run.id)?.state).toBe("failed");
    expect(h.repository.get(task.id)?.consecutiveFailures).toBe(0);
    expect(h.repository.get(task.id)?.lastError).toBeNull();
  });

  it("performs boot recovery without thundering herd and skips missed once tasks", () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const archivedConv = h.addConversation();

    // Seed tasks created earlier when app was open
    const recurringStale = h.repository.create({
      id: randomUUID(),
      projectId: PROJECT_ID,
      title: "Stale recurring",
      prompt: "Ping",
      schedule: { type: "interval", everyMs: 60_000 },
      nextRunAt: "2026-05-10T08:00:00.000Z",
      now: "2026-05-10T07:59:00.000Z",
    });
    const onceStale = h.repository.create({
      id: randomUUID(),
      projectId: PROJECT_ID,
      title: "Missed once",
      prompt: "Alert",
      schedule: { type: "once", runAt: "2026-05-10T09:00:00.000Z" },
      nextRunAt: "2026-05-10T09:00:00.000Z",
      now: "2026-05-10T08:00:00.000Z",
    });
    const archivedBound = h.repository.create({
      id: randomUUID(),
      projectId: PROJECT_ID,
      title: "Archived bound",
      prompt: "Hello",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: archivedConv.id,
      nextRunAt: "2026-05-10T10:05:00.000Z",
      now: "2026-05-10T09:00:00.000Z",
    });
    h.repository.archivedConversationIds.add(archivedConv.id);

    // Seed a stranded claimed run
    const strandedRun = h.repository.claimRun({
      runId: randomUUID(),
      taskId: recurringStale.id,
      claimKey: `sched:${recurringStale.id}:2026-05-10T07:59:00.000Z`,
      trigger: "schedule",
      scheduledFor: "2026-05-10T07:59:00.000Z",
      claimedAt: "2026-05-10T07:59:00.000Z",
      nextRunAtAfterClaim: "2026-05-10T08:00:00.000Z",
    })!;

    h.service.start();
    try {
      expect(h.dispatched).toHaveLength(0);
      expect(h.repository.getRun(strandedRun.id)?.state).toBe("failed");
      expect(h.repository.get(archivedBound.id)?.enabled).toBe(false);
      expect(h.repository.get(recurringStale.id)?.nextRunAt).toBe("2026-05-10T10:01:00.000Z");

      const missedOnceAfter = h.repository.get(onceStale.id)!;
      expect(missedOnceAfter.enabled).toBe(false);
      expect(missedOnceAfter.nextRunAt).toBeNull();
      expect(missedOnceAfter.lastRunStatus).toBe("skipped");
      expect(missedOnceAfter.lastError).toBe(SCHEDULED_TASK_MISSED_BOOT_ERROR);
    } finally {
      h.service.dispose();
    }
  });

  it("respects update hold on both timer ticks and manual runNow", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();
    const task = h.service.create({
      projectId: PROJECT_ID,
      title: "Hold-aware task",
      prompt: "Run check",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: conv.id,
    });

    hold();
    h.setNow("2026-05-10T10:01:00.000Z");
    await h.service.tick();
    expect(h.dispatched).toHaveLength(0);
    await expect(h.service.runNow(task.id)).rejects.toThrow(UPDATE_HOLD_MESSAGE);

    release();
    await h.service.tick();
    expect(h.dispatched).toHaveLength(1);
  });

  it("routes all five scheduled-task runtime commands cleanly", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();
    const sent: ServerEvent[] = [];
    const socket = {} as WebSocket;
    const handler = createScheduledTaskCommandHandler({
      scheduledTasks: h.service,
      send: (_socket, event) => {
        sent.push(event);
      },
    });

    const dispatchCommand = async (command: ClientCommand) => {
      const disposition = await handler(socket, command);
      expect(disposition).toBe("handled");
      return sent.at(-1)!;
    };

    const createdEvent = await dispatchCommand({
      type: "scheduled-task.create",
      requestId: "req-1",
      payload: {
        projectId: PROJECT_ID,
        title: "Nightly audit",
        prompt: "Audit dependencies",
        schedule: { type: "interval", everyMs: 300_000 },
        boundConversationId: conv.id,
      },
    });
    expect(createdEvent.type).toBe("request.result");
    const createdTask = (createdEvent as Extract<ServerEvent, { type: "request.result" }>).result as {
      kind: "scheduled-task";
      task: ScheduledTask;
      recentRuns: ScheduledTaskRun[];
    };
    expect(createdTask.kind).toBe("scheduled-task");
    expect(createdTask.recentRuns).toEqual([]);

    const listEvent = await dispatchCommand({
      type: "scheduled-task.list",
      requestId: "req-2",
      payload: { projectId: PROJECT_ID },
    });
    expect((listEvent as Extract<ServerEvent, { type: "request.result" }>).result).toMatchObject({
      kind: "scheduled-tasks.list",
      tasks: [{ task: { id: createdTask.task.id } }],
    });

    const updatedEvent = await dispatchCommand({
      type: "scheduled-task.update",
      requestId: "req-3",
      payload: { taskId: createdTask.task.id, patch: { title: "Updated audit" } },
    });
    expect((updatedEvent as Extract<ServerEvent, { type: "request.result" }>).result).toMatchObject({
      kind: "scheduled-task",
      task: { title: "Updated audit" },
    });

    const ranEvent = await dispatchCommand({
      type: "scheduled-task.run-now",
      requestId: "req-4",
      payload: { taskId: createdTask.task.id },
    });
    expect((ranEvent as Extract<ServerEvent, { type: "request.result" }>).result).toMatchObject({
      kind: "scheduled-task.ran",
      conversationId: conv.id,
    });

    const deletedEvent = await dispatchCommand({
      type: "scheduled-task.delete",
      requestId: "req-5",
      payload: { taskId: createdTask.task.id },
    });
    expect(deletedEvent).toEqual({ type: "request.ok", requestId: "req-5" });
    expect(h.service.list(PROJECT_ID)).toEqual([]);
  });

  it("supports bindRunTurn to transition a queued run to running before settlement", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();
    const task = h.service.create({
      projectId: PROJECT_ID,
      title: "Queue-bound run",
      prompt: "Check migrations",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: conv.id,
    });

    const ran = await h.service.runNow(task.id);
    const queueItemId = ran.run.queueItemId!;
    expect(h.service.providerContentForQueueItem(queueItemId)).toContain("scheduled task");

    const running = h.service.bindRunTurn(queueItemId, "turn-bound-1");
    expect(running?.state).toBe("running");
    expect(running?.turnId).toBe("turn-bound-1");
    expect(h.repository.get(task.id)?.lastRunStatus).toBe("running");

    const onSettledSpy = vi.spyOn(h.repository, "recordTaskOutcome");
    h.service.onTurnSettled({
      id: "turn-bound-1",
      conversationId: conv.id,
      status: "completed",
      terminalReason: null,
      completedAt: "2026-05-10T10:00:15.000Z",
      updatedAt: "2026-05-10T10:00:15.000Z",
    });
    expect(onSettledSpy).toHaveBeenCalledTimes(1);
    expect(h.repository.get(task.id)?.lastRunStatus).toBe("completed");
    expect(h.service.providerContentForQueueItem(queueItemId)).toBeNull();
  });

  it("S24: unrelated turn completing on a bound chat does not settle a waiting scheduled run or free its slot", async () => {
    const h = createHarness("2026-05-10T10:00:00.000Z");
    const conv = h.addConversation();
    const task = h.service.create({
      projectId: PROJECT_ID,
      title: "Bound hourly check",
      prompt: "Check build",
      schedule: { type: "interval", everyMs: 60_000 },
      boundConversationId: conv.id,
    });

    const ran = await h.service.runNow(task.id);
    expect(ran.run.state).toBe("queued");

    // An unrelated user turn completes on the same conversation while scheduled run is still waiting
    h.service.onTurnSettled({
      id: "unrelated-turn-1",
      conversationId: conv.id,
      status: "completed",
      terminalReason: null,
      completedAt: "2026-05-10T10:00:05.000Z",
      updatedAt: "2026-05-10T10:00:05.000Z",
    });

    // Scheduled run remains queued and its occurrence slot is still occupied
    expect(h.repository.getRun(ran.run.id)?.state).toBe("queued");
    expect(h.repository.hasActiveQueuedOrRunningOccurrence(task.id)).toBe(true);
    await expect(h.service.runNow(task.id)).rejects.toThrow(/active queued or running/i);

    // Binding the real turnId and settling it completes the run and frees the slot
    h.service.bindRunTurn(ran.run.id, "scheduled-turn-1");
    expect(h.repository.getRun(ran.run.id)?.state).toBe("running");
    h.service.onTurnSettled({
      id: "scheduled-turn-1",
      conversationId: conv.id,
      status: "completed",
      terminalReason: null,
      completedAt: "2026-05-10T10:00:15.000Z",
      updatedAt: "2026-05-10T10:00:15.000Z",
    });
    expect(h.repository.getRun(ran.run.id)?.state).toBe("completed");
    expect(h.repository.hasActiveQueuedOrRunningOccurrence(task.id)).toBe(false);
  });

  it("S25: boot recovery reconciles stranded claimed, orphaned/cancelled/blocked/delivered queued, and terminal running runs", () => {
    const now = new Date("2026-05-10T12:00:00.000Z");
    const repo = new InMemoryScheduledTaskRepository();
    const queueItems = new Map<string, QueueItemProjection>();
    const turnsById = new Map<string, Pick<AgentTurn, "id" | "conversationId" | "status" | "terminalReason" | "completedAt" | "updatedAt">>();
    const convId = randomUUID();

    const store: ScheduledTaskStoreLike = {
      project: () => ({ id: PROJECT_ID, name: "Alpha" }),
      conversation: () => ({
        id: convId,
        projectId: PROJECT_ID,
        title: "Bound",
        archivedAt: null,
        accessMode: "full",
        interactionMode: "build",
        modelSelection: MODEL_SELECTION,
      }),
      agentTurn: (turnId) => {
        const found = turnsById.get(turnId);
        if (!found) throw new RecordNotFoundError(`Turn ${turnId} not found`);
        return found;
      },
      orchestration: {
        queue: {
          enqueue: () => { throw new Error("not used"); },
          getItem: (itemId) => queueItems.get(itemId) ?? null,
        },
      },
    };

    const service = new ScheduledTaskService({
      repository: repo,
      store,
      now: () => now,
      broadcast: () => undefined,
      createConversation: async () => ({ id: convId, projectId: PROJECT_ID, title: "New", archivedAt: null }),
    });

    const mkTask = (title: string) => repo.create({
      id: randomUUID(),
      projectId: PROJECT_ID,
      title,
      prompt: "Check",
      schedule: { type: "interval", everyMs: 60_000 },
      nextRunAt: "2026-05-10T12:05:00.000Z",
      now: "2026-05-10T11:00:00.000Z",
    });

    const mkQueueItem = (itemId: string, state: QueueItemProjection["state"], turnId?: string): QueueItemProjection => ({
      id: itemId,
      threadId: convId,
      projectId: PROJECT_ID,
      kind: "message",
      userMessageId: null,
      createdBy: "system",
      creationSource: "server",
      contentRef: { chars: 5, editRevision: 0 },
      attachmentIds: [],
      queuePosition: state === "waiting" ? 1 : null,
      queueHeld: false,
      requestedAt: "2026-05-10T11:50:00.000Z",
      editedAt: null,
      state,
      ...(state === "cancelled" ? { cancelReason: "user" as const } : {}),
      ...(state === "blocked" ? { blockedReason: "dispatch-failed", detail: "Provider offline" } : {}),
      dispatchOrdinal: state === "delivered" ? 1 : 0,
      ...(turnId ? {
        delivery: {
          mode: "run" as const,
          runId: randomUUID(),
          attemptId: randomUUID(),
          turnId,
          messageId: randomUUID(),
          deliveredAt: "2026-05-10T11:51:00.000Z",
        },
      } : {}),
    });

    // 1. Stranded claimed (no queueItemId)
    const tClaimed = mkTask("Claimed");
    const rClaimed = repo.claimRun({
      runId: randomUUID(), taskId: tClaimed.id, claimKey: "c1", trigger: "manual",
      scheduledFor: null, claimedAt: "2026-05-10T11:50:00.000Z", nextRunAtAfterClaim: tClaimed.nextRunAt,
    })!;

    // 2. Orphaned queued (queueItem missing)
    const tOrphan = mkTask("Orphan");
    const rOrphan = repo.claimRun({
      runId: randomUUID(), taskId: tOrphan.id, claimKey: "c2", trigger: "manual",
      scheduledFor: null, claimedAt: "2026-05-10T11:50:00.000Z", nextRunAtAfterClaim: tOrphan.nextRunAt,
    })!;
    repo.updateRun(rOrphan.id, { state: "queued", conversationId: convId, queueItemId: "missing-q", updatedAt: "2026-05-10T11:50:00.000Z" });

    // 3. Cancelled queued
    const tCancelled = mkTask("Cancelled");
    const rCancelled = repo.claimRun({
      runId: randomUUID(), taskId: tCancelled.id, claimKey: "c3", trigger: "manual",
      scheduledFor: null, claimedAt: "2026-05-10T11:50:00.000Z", nextRunAtAfterClaim: tCancelled.nextRunAt,
    })!;
    const qCancelledId = randomUUID();
    queueItems.set(qCancelledId, mkQueueItem(qCancelledId, "cancelled"));
    repo.updateRun(rCancelled.id, { state: "queued", conversationId: convId, queueItemId: qCancelledId, updatedAt: "2026-05-10T11:50:00.000Z" });

    // 4. Blocked queued
    const tBlocked = mkTask("Blocked");
    const rBlocked = repo.claimRun({
      runId: randomUUID(), taskId: tBlocked.id, claimKey: "c4", trigger: "manual",
      scheduledFor: null, claimedAt: "2026-05-10T11:50:00.000Z", nextRunAtAfterClaim: tBlocked.nextRunAt,
    })!;
    const qBlockedId = randomUUID();
    queueItems.set(qBlockedId, mkQueueItem(qBlockedId, "blocked"));
    repo.updateRun(rBlocked.id, { state: "queued", conversationId: convId, queueItemId: qBlockedId, updatedAt: "2026-05-10T11:50:00.000Z" });

    // 5. Delivered queued whose turn already completed
    const tDelivered = mkTask("Delivered");
    const rDelivered = repo.claimRun({
      runId: randomUUID(), taskId: tDelivered.id, claimKey: "c5", trigger: "manual",
      scheduledFor: null, claimedAt: "2026-05-10T11:50:00.000Z", nextRunAtAfterClaim: tDelivered.nextRunAt,
    })!;
    const qDeliveredId = randomUUID();
    const deliveredTurnId = randomUUID();
    queueItems.set(qDeliveredId, mkQueueItem(qDeliveredId, "delivered", deliveredTurnId));
    turnsById.set(deliveredTurnId, {
      id: deliveredTurnId, conversationId: convId, status: "completed",
      terminalReason: null, completedAt: "2026-05-10T11:52:00.000Z", updatedAt: "2026-05-10T11:52:00.000Z",
    });
    repo.updateRun(rDelivered.id, { state: "queued", conversationId: convId, queueItemId: qDeliveredId, updatedAt: "2026-05-10T11:50:00.000Z" });

    // 6. Running run whose turn is already interrupted
    const tRunning = mkTask("Running");
    const rRunning = repo.claimRun({
      runId: randomUUID(), taskId: tRunning.id, claimKey: "c6", trigger: "manual",
      scheduledFor: null, claimedAt: "2026-05-10T11:50:00.000Z", nextRunAtAfterClaim: tRunning.nextRunAt,
    })!;
    const runningTurnId = randomUUID();
    turnsById.set(runningTurnId, {
      id: runningTurnId, conversationId: convId, status: "interrupted",
      terminalReason: "Runtime restarted", completedAt: "2026-05-10T11:55:00.000Z", updatedAt: "2026-05-10T11:55:00.000Z",
    });
    repo.updateRun(rRunning.id, { state: "running", conversationId: convId, turnId: runningTurnId, updatedAt: "2026-05-10T11:51:00.000Z" });

    // 7. Live queue-item cancellation via onRunQueueCancelled
    const tLiveCancel = mkTask("LiveCancel");
    const rLiveCancel = repo.claimRun({
      runId: randomUUID(), taskId: tLiveCancel.id, claimKey: "c7", trigger: "manual",
      scheduledFor: null, claimedAt: "2026-05-10T11:50:00.000Z", nextRunAtAfterClaim: tLiveCancel.nextRunAt,
    })!;
    const qWaitingId = randomUUID();
    queueItems.set(qWaitingId, mkQueueItem(qWaitingId, "waiting"));
    repo.updateRun(rLiveCancel.id, { state: "queued", conversationId: convId, queueItemId: qWaitingId, updatedAt: "2026-05-10T11:50:00.000Z" });

    service.start();
    try {
      expect(repo.getRun(rClaimed.id)?.state).toBe("failed");
      expect(repo.getRun(rOrphan.id)?.state).toBe("failed");
      expect(repo.getRun(rCancelled.id)?.state).toBe("skipped");
      expect(repo.getRun(rBlocked.id)?.state).toBe("failed");
      expect(repo.getRun(rDelivered.id)?.state).toBe("completed");
      expect(repo.getRun(rDelivered.id)?.turnId).toBe(deliveredTurnId);
      expect(repo.get(tDelivered.id)?.lastRunStatus).toBe("completed");
      expect(repo.getRun(rRunning.id)?.state).toBe("failed");
      expect(repo.get(tRunning.id)?.lastRunStatus).toBe("failed");
      expect(repo.get(tRunning.id)?.consecutiveFailures).toBe(1);
      // Waiting item stays queued across boot until cancelled or dispatched
      expect(repo.getRun(rLiveCancel.id)?.state).toBe("queued");

      // Cancelling the queue item immediately reconciles the run and frees the slot
      queueItems.set(qWaitingId, mkQueueItem(qWaitingId, "cancelled"));
      service.onRunQueueCancelled(rLiveCancel.id, "Removed from the chat queue.");
      expect(repo.getRun(rLiveCancel.id)?.state).toBe("skipped");
      expect(repo.hasActiveQueuedOrRunningOccurrence(tLiveCancel.id)).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it("S23 + S25 + S26 + S32: dispatches scheduled tasks in a new chat, enforces min(task, chat) modes, applies sender note and freshContext at dispatch, and respects stop/update hold", async () => {
    let queue: ReturnType<typeof createQueuedMessageRuntime> | undefined;
    let service: ScheduledTaskService | undefined;
    const runtime = await createTurnControllerTestRuntime({
      onTurnSettled: (turn) => {
        queue?.onTurnSettled(turn);
        service?.onTurnSettled(turn);
      },
    });
    const attachments = await ConversationAttachmentStore.open(runtime.directory);
    const abort = new AbortController();
    const tasks = new Set<Promise<unknown>>();
    try {
      const dependencies: TurnInteractionCommandDependencies = {
        store: runtime.store,
        turns: runtime.controller,
        conversationAttachments: attachments,
        backendProfileController: {
          validateSelection: (selection: unknown) => selection,
          isExternalSelection: () => false,
          readiness: async () => null,
        } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
        isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
        workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
        pendingApprovals: new Map(),
        pendingInputs: new Map(),
        dataDirectory: runtime.directory,
        enableProviders: true,
        attachmentResolver: null,
        generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
        workflows: {
          resolveTurnSkills: async () => ({ inputs: [], routeKey: null }),
          assertTurnSkillsCurrent: () => undefined,
        } as unknown as TurnInteractionCommandDependencies["workflows"],
        providerTerminalResumes: {
          isActive: () => false,
          acquireWhenAvailable: async () => true,
          release: () => undefined,
        } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
        providerInfo: () => [turnControllerTestProviderInfo()],
        broadcast: () => undefined,
        broadcastSnapshot: () => undefined,
        send: () => undefined,
      };

      queue = createQueuedMessageRuntime(dependencies, {
        signal: abort.signal,
        track: (operation) => {
          const op = operation();
          tasks.add(op);
          void op.finally(() => tasks.delete(op));
          return op;
        },
        onScheduledDispatched: (runId, turnId) => service?.bindRunTurn(runId, turnId),
        onScheduledCancelled: (runId, reason) => service?.onRunQueueCancelled(runId, reason),
        cancelStaleScheduledTask: (conversationId, itemId, attr) => service?.cancelIfStale(conversationId, itemId, attr) ?? false,
      });

      service = new ScheduledTaskService({
        repository: runtime.store.scheduledTasks,
        store: runtime.store,
        createConversation: async (input) => runtime.store.createConversation(input.projectId, input.title, {
          interactionMode: input.interactionMode,
          accessMode: input.accessMode,
          activate: false,
        }),
        messageQueue: () => queue,
        broadcast: () => undefined,
        enableProviders: true,
      });

      const drain = async () => {
        await flushTurnControllerTestPromises();
        while (tasks.size > 0) await Promise.allSettled(tasks);
        await flushTurnControllerTestPromises();
      };

      const projectId = runtime.store.conversation(runtime.conversationId).projectId;

      // 1) S23 + S25 + S32: scheduled task on a brand-new chat (no prior turns) dispatches automatically!
      const newChatTask = service.create({
        projectId,
        title: "Fresh chat schedule",
        prompt: "Report repo health",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: null,
        accessMode: "supervised",
        interactionMode: "plan",
      });
      const newChatRun = await service.runNow(newChatTask.id);
      // S25: queue item persisted atomically with scheduledTask attribution
      const qItem = runtime.store.orchestration.queue.getItem(newChatRun.run.queueItemId!);
      expect(qItem?.attribution && "scheduledTask" in qItem.attribution ? qItem.attribution.scheduledTask.runId : null)
        .toBe(newChatRun.run.id);

      await drain();
      expect(runtime.provider.runCount).toBe(1);
      const firstProviderInput = runtime.provider.input!;
      expect(firstProviderInput.conversationId).toBe(newChatRun.conversationId);
      // S32: execution prompt carries scheduled sender note while persisted user message stays clean
      expect(firstProviderInput.prompt).toContain("[Inertia: scheduled task \"Fresh chat schedule\"");
      expect(firstProviderInput.prompt).toContain("Report repo health");
      const persistedMessages = runtime.store.conversationDetail(newChatRun.conversationId)?.messages ?? [];
      expect(persistedMessages.find((m) => m.role === "user")?.content).toBe("Report repo health");
      expect(runtime.store.scheduledTasks.getRun(newChatRun.run.id)?.state).toBe("running");

      // Complete the turn -> scheduled run settles to completed
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
      runtime.provider.resolve({ sessionId: "sched-session-1" });
      await drain();
      expect(runtime.store.scheduledTasks.getRun(newChatRun.run.id)?.state).toBe("completed");
      expect(runtime.store.scheduledTasks.get(newChatTask.id)?.lastRunStatus).toBe("completed");

      // 2) S26 + S32: bound chat (full/build with existing providerSessionId) + task (auto-edit/plan, freshSession: true)
      // executes at min(task, chat) = (auto-edit, plan) and suppresses native continuation (no sessionId)!
      runtime.store.updateConversation(runtime.conversationId, {
        accessMode: "full",
        interactionMode: "build",
      });
      const initialTurn = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Seed session" });
      runtime.controller.start(initialTurn.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
      runtime.provider.resolve({ sessionId: "prior-session-42" });
      await drain();
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("prior-session-42");

      const restrictedFreshTask = service.create({
        projectId,
        title: "Restricted fresh task",
        prompt: "Review recent diff",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: runtime.conversationId,
        accessMode: "auto-edit",
        interactionMode: "plan",
        freshSession: true,
      });

      // Hold updates before enqueueing to prove update hold blocks dispatch AND session is NOT prematurely reset at enqueue!
      hold();
      const restrictedRun = await service.runNow(restrictedFreshTask.id).catch(() => null);
      expect(restrictedRun).toBeNull(); // runNow itself rejects under update hold
      release();

      // Enqueue while conversation is held via H1-stop -> Stop blocks dispatch and session stays intact
      const dummyId = randomUUID();
      runtime.store.orchestration.queue.enqueue({
        conversationId: runtime.conversationId,
        itemId: dummyId,
        content: "Held user item",
        queueHeld: true,
      });
      const heldSchedRun = await service.runNow(restrictedFreshTask.id);
      // Session was NOT prematurely cleared at enqueue time (S32)
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("prior-session-42");
      await drain();
      // Still blocked because H1-stop hold was inherited
      expect(runtime.provider.runCount).toBe(2); // only first scheduled + seed turn
      expect(runtime.store.scheduledTasks.getRun(heldSchedRun.run.id)?.state).toBe("queued");

      // Removing the queued scheduled item immediately cancels/skips the scheduled run (S25)
      await queue.handler(null as unknown as WebSocket, {
        type: "message.queue.remove",
        requestId: randomUUID(),
        payload: { conversationId: runtime.conversationId, id: heldSchedRun.run.queueItemId! },
      });
      expect(runtime.store.scheduledTasks.getRun(heldSchedRun.run.id)?.state).toBe("skipped");

      // Cancel the held dummy item, then run the restricted fresh task for real!
      runtime.store.orchestration.queue.cancel({ conversationId: runtime.conversationId, itemId: dummyId, reason: "user" });
      const liveRestrictedRun = await service.runNow(restrictedFreshTask.id);
      await drain();
      expect(runtime.provider.runCount).toBe(3);
      const restrictedProviderInput = runtime.provider.input!;
      // S26: executed at min(chat=full/build, task=auto-edit/plan) => auto-edit + plan!
      expect(restrictedProviderInput.access).toBe("auto-edit");
      expect(restrictedProviderInput.interactionMode).toBe("plan");
      // S32: freshContext suppressed native continuation!
      expect(restrictedProviderInput.sessionId).toBeUndefined();
      expect(restrictedProviderInput.nativeContinuation).toBeUndefined();
      expect(restrictedProviderInput.prompt).toContain("[Inertia: scheduled task \"Restricted fresh task\"");

      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
      runtime.provider.resolve({ sessionId: "fresh-session-99" });
      await drain();
      expect(runtime.store.scheduledTasks.getRun(liveRestrictedRun.run.id)?.state).toBe("completed");

      // 3) S32: leading $skill stays verbatim in execution prompt (not prefixed with sender note)
      const skillTask = service.create({
        projectId,
        title: "Skill task",
        prompt: "$deploy check canary",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: runtime.conversationId,
        accessMode: "full",
        interactionMode: "build",
      });
      const skillRun = await service.runNow(skillTask.id);
      await drain();
      expect(runtime.provider.runCount).toBe(4);
      const skillProviderInput = runtime.provider.input!;
      expect(skillProviderInput.prompt.startsWith("$deploy check canary")).toBe(true);
      expect(skillProviderInput.prompt).not.toContain("[Inertia: scheduled task");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
      runtime.provider.resolve({ sessionId: "fresh-session-99" });
      await drain();
      expect(runtime.store.scheduledTasks.getRun(skillRun.run.id)?.state).toBe("completed");

      // 4) S23: bootAutoResend=true dispatches automatically on a brand-new chat when unheld
      const bootResendConv = runtime.store.createConversation(projectId, "Boot resend chat", { activate: false });
      const bootItemId = randomUUID();
      runtime.store.orchestration.queue.enqueue({
        conversationId: bootResendConv.id,
        itemId: bootItemId,
        content: "Resend after boot",
        bootAutoResend: true,
        queueHeld: false,
      });
      await queue.schedule(bootResendConv.id);
      await drain();
      expect(runtime.provider.runCount).toBe(5);
      expect(runtime.provider.input!.conversationId).toBe(bootResendConv.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
      runtime.provider.resolve({ sessionId: "boot-resend-session" });
      await drain();

      // 5) S39: deleting a scheduled task cancels its queued prompt immediately AND dispatch-time cancelIfStale blocks any orphaned item
      const busyHoldId = randomUUID();
      runtime.store.orchestration.queue.enqueue({
        conversationId: runtime.conversationId,
        itemId: busyHoldId,
        content: "Hold queue before delete",
        queueHeld: true,
      });
      const deleteQueuedTask = service.create({
        projectId,
        title: "Delete while queued",
        prompt: "Should never run after delete",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: runtime.conversationId,
      });
      const deleteQueuedRun = await service.runNow(deleteQueuedTask.id);
      expect(runtime.store.orchestration.queue.getItem(deleteQueuedRun.run.queueItemId!)?.state).toBe("waiting");

      service.delete(deleteQueuedTask.id);
      expect(runtime.store.orchestration.queue.getItem(deleteQueuedRun.run.queueItemId!)?.state).toBe("cancelled");

      // Also verify dispatch-time stale-run withdrawal if a queued item references a missing/deleted task
      const staleItemId = randomUUID();
      runtime.store.orchestration.queue.enqueue({
        conversationId: runtime.conversationId,
        itemId: staleItemId,
        content: "Stale deleted task prompt",
        queueHeld: false,
        skipHoldInheritance: true,
        attribution: {
          scheduledTask: {
            taskId: randomUUID(),
            runId: randomUUID(),
            title: "Deleted externally",
            accessMode: "supervised",
            interactionMode: "plan",
          },
        },
      });
      runtime.store.orchestration.queue.cancel({ conversationId: runtime.conversationId, itemId: busyHoldId, reason: "user" });
      await queue.schedule(runtime.conversationId);
      await drain();
      expect(runtime.store.orchestration.queue.getItem(staleItemId)?.state).toBe("cancelled");
      expect(runtime.provider.runCount).toBe(5);

      // 6) S41: deleting the generated chat of a queued/active unbound scheduled run settles that run so future runs aren't wedged
      const unboundDeleteChatTask = service.create({
        projectId,
        title: "Unbound chat deleted while queued",
        prompt: "Check repo",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: null,
      });
      const deletedChat = runtime.store.createConversation(projectId, "Ephemeral scheduled chat", { activate: false });
      const activeRunId = randomUUID();
      const wedgedRun = runtime.store.scheduledTasks.claimRun({
        runId: activeRunId,
        taskId: unboundDeleteChatTask.id,
        claimKey: `s41:${activeRunId}`,
        trigger: "manual",
        scheduledFor: null,
        claimedAt: new Date().toISOString(),
        nextRunAtAfterClaim: unboundDeleteChatTask.nextRunAt,
      })!;
      runtime.store.scheduledTasks.updateRun(wedgedRun.id, {
        state: "queued",
        conversationId: deletedChat.id,
        queueItemId: randomUUID(),
        updatedAt: new Date().toISOString(),
      });
      expect(runtime.store.scheduledTasks.hasActiveQueuedOrRunningOccurrence(unboundDeleteChatTask.id)).toBe(true);
      runtime.store.deleteConversation(deletedChat.id);
      service.onConversationDeleted(deletedChat.id, projectId);
      expect(runtime.store.scheduledTasks.getRun(wedgedRun.id)?.state).toBe("skipped");
      expect(runtime.store.scheduledTasks.hasActiveQueuedOrRunningOccurrence(unboundDeleteChatTask.id)).toBe(false);
    } finally {
      abort.abort();
      service?.dispose();
      await runtime.controller.dispose();
      await attachments.close();
      runtime.store.close();
    }
  });
});
