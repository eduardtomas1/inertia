// @inertia-test-suite portable

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import type {
  ClientCommand,
  Conversation,
  Project,
  RuntimeMutationEvent,
  ServerEvent,
} from "../../src/shared/contracts";
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
import {
  SCHEDULED_TASK_MISSED_BOOT_ERROR,
  ScheduledTaskService,
  type ScheduledTaskEnqueuePromptInput,
  type ScheduledTaskRepositoryLike,
  type ScheduledTaskStoreLike,
} from "../../src/server/runtime/scheduled-tasks/scheduled-task-service";
import { hold, release, UPDATE_HOLD_MESSAGE } from "../../src/server/runtime/update-hold";

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

    // 1) Bound + freshSession: reuses conversation, calls resetConversationSession, sets freshContext: true
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
    expect(h.resetCalls).toEqual([boundConv.id]);
    expect(h.dispatched[0]?.freshContext).toBe(true);

    // 2) Unbound + freshSession: first run creates conversation and binds it; second run reuses and resets it
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

    // Finish first run so second run can execute
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
    expect(h.resetCalls).toContain(r2a.conversationId);

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
});
