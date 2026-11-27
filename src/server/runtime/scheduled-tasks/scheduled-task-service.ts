import { randomUUID } from "node:crypto";

import type {
  AgentTurn, Conversation, ModelSelection, Project, RuntimeMutationEvent,
} from "../../../shared/contracts";
import { queueContentCharCount } from "../../../shared/orchestration-queue";
import {
  computeNextScheduledRunAt,
  MAX_SCHEDULED_TASK_RUN_HISTORY,
  MAX_SCHEDULED_TASKS_PER_PROJECT,
  MAX_SCHEDULED_TASKS_TOTAL,
  normalizeScheduledTaskError,
  SCHEDULED_TASK_FAILURE_TRACKING_WINDOW_MS,
  scheduledTaskCreateInputSchema,
  scheduledTaskPatchSchema,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskPatch,
  type ScheduledTaskRun,
  type ScheduledTaskRunStatus,
  type ScheduledTaskRunTrigger,
  type ScheduledTaskSummary,
} from "../../../shared/scheduled-tasks";
import type { OrchestrationQueueRepository } from "../../orchestration-v2/queue-repository";
import { RecordNotFoundError } from "../../persistence/errors";
import { RuntimeRequestError, USER_CORRECTABLE_REQUEST } from "../../runtime-errors";
import { withAgentSenderNote } from "../agent-sender-note";
import { isHeld, UPDATE_HOLD_MESSAGE } from "../update-hold";

export const MAX_TIMER_DELAY_MS = 60_000;
const UPDATE_HOLD_RETRY_DELAY_MS = 5_000;
const MAX_DUE_PER_TICK = 25;
const MAX_CONVERSATION_TITLE_CHARS = 120;

export const SCHEDULED_TASK_NOT_FOUND_MESSAGE = "Scheduled task not found.";
export const SCHEDULED_TASK_PROJECT_MISSING_MESSAGE = "Project not found for scheduled task.";
export const SCHEDULED_TASK_BOUND_CHAT_MISSING_MESSAGE = "Target chat not found for scheduled task.";
export const SCHEDULED_TASK_BOUND_CHAT_PROJECT_MESSAGE = "Target chat does not belong to the scheduled task's project.";
export const SCHEDULED_TASK_BOUND_CHAT_ARCHIVED_MESSAGE = "Archived chats cannot receive scheduled runs.";
export const SCHEDULED_TASK_PAST_ONCE_MESSAGE = "One-time scheduled tasks must be scheduled in the future.";
export const SCHEDULED_TASK_ALREADY_RUNNING_MESSAGE = "This scheduled task already has an active queued or running occurrence.";
export const SCHEDULED_TASK_IN_FLIGHT_MESSAGE = "This scheduled task is already starting a run.";
export const SCHEDULED_TASK_MISSED_BOOT_ERROR = "Missed scheduled time while Inertia was closed.";
export const SCHEDULED_TASK_STRANDED_BOOT_ERROR = "Inertia restarted before the scheduled run could be queued.";

export interface ScheduledTaskRepositoryLike {
  list(projectId?: string): ScheduledTask[];
  get(taskId: string): ScheduledTask | null;
  create(input: ScheduledTaskCreateInput & { id: string; nextRunAt: string | null; now: string }): ScheduledTask;
  update(taskId: string, patch: ScheduledTaskPatch & { nextRunAt?: string | null; now: string; lastError?: string | null; consecutiveFailures?: number; lastRunAt?: string | null; lastRunStatus?: ScheduledTaskRunStatus | null; lastConversationId?: string | null; lastTurnId?: string | null }): ScheduledTask;
  delete(taskId: string): boolean;
  listDue(nowIso: string, limit?: number): ScheduledTask[];
  listRuns(taskId: string, limit?: number): ScheduledTaskRun[];
  listActiveRuns(): ScheduledTaskRun[];
  getRun(runId: string): ScheduledTaskRun | null;
  findRunByTurnId(turnId: string): ScheduledTaskRun | null;
  hasActiveQueuedOrRunningOccurrence(taskId: string): boolean;
  claimRun(input: { runId: string; taskId: string; claimKey: string; trigger: ScheduledTaskRunTrigger; scheduledFor: string | null; claimedAt: string; nextRunAtAfterClaim: string | null; disableTaskAfterClaim?: boolean }): ScheduledTaskRun | null;
  updateRun(runId: string, patch: { state?: ScheduledTaskRunStatus; conversationId?: string | null; turnId?: string | null; queueItemId?: string | null; error?: string | null; finishedAt?: string | null; updatedAt: string }): ScheduledTaskRun | null;
  recordTaskOutcome(taskId: string, outcome: { lastRunAt: string; lastRunStatus: ScheduledTaskRunStatus; lastConversationId?: string | null; lastTurnId?: string | null; lastError: string | null; consecutiveFailures: number; updatedAt: string }): ScheduledTask | null;
  reconcileStrandedRuns(nowIso: string, errorMessage: string): ScheduledTaskRun[];
  disableTasksForMissingOrArchivedTarget(nowIso: string): string[];
}

export interface ScheduledTaskStoreLike {
  project(projectId: string): Pick<Project, "id" | "name">;
  conversation(conversationId: string): Pick<Conversation, "id" | "projectId" | "title" | "archivedAt" | "accessMode" | "interactionMode" | "modelSelection">;
  agentTurn?(turnId: string): Pick<AgentTurn, "id" | "conversationId" | "status" | "terminalReason" | "completedAt" | "updatedAt">;
  orchestration?: { queue: Pick<OrchestrationQueueRepository, "enqueue"> & Partial<Pick<OrchestrationQueueRepository, "getItem" | "cancel">> };
}

export interface ScheduledTaskConversationCreateInput {
  projectId: string;
  title: string;
  modelSelection: ModelSelection | null;
  interactionMode: ScheduledTask["interactionMode"];
  accessMode: ScheduledTask["accessMode"];
  requestId: string;
}

export interface ScheduledTaskEnqueuePromptInput {
  task: ScheduledTask;
  run: ScheduledTaskRun;
  conversationId: string;
  content: string;
  providerContent: string;
  modelSelection: ModelSelection | null;
  followsThreadSelection: boolean;
  freshContext: boolean;
  queueItemId: string;
  requestedAt: string;
}

export interface ScheduledTaskEnqueuePromptResult {
  queueItemId: string;
  turnId?: string | null;
  linkedRun?: ScheduledTaskRun | null;
  linkedTask?: ScheduledTask | null;
}

export interface ScheduledTaskMessageQueueLike {
  schedule?(conversationId: string): void | Promise<void>;
  onExternalQueueChanged?(conversationId: string): void;
}

export interface ScheduledTaskServiceDependencies {
  repository: ScheduledTaskRepositoryLike;
  store: ScheduledTaskStoreLike;
  createConversation(input: ScheduledTaskConversationCreateInput): Promise<Pick<Conversation, "id" | "projectId" | "title" | "archivedAt">>;
  enqueueScheduledPrompt?(input: ScheduledTaskEnqueuePromptInput): Promise<ScheduledTaskEnqueuePromptResult> | ScheduledTaskEnqueuePromptResult;
  resetConversationSession?(conversationId: string): Promise<void> | void;
  messageQueue?(): ScheduledTaskMessageQueueLike | undefined;
  isUpdateHeld?(): boolean;
  broadcast(event: RuntimeMutationEvent): void;
  now?(): Date;
  createId?(): string;
  enableProviders?: boolean;
}

export interface ScheduledTaskRunNowResult {
  task: ScheduledTask;
  run: ScheduledTaskRun;
  conversationId: string;
}

interface TrackedScheduledRun {
  runId: string;
  taskId: string;
  conversationId: string;
  queueItemId: string;
  turnId: string | null;
  claimedAt: string;
  providerContent: string;
}

class MissingOrArchivedTargetError extends Error {}

function userError(message: string): RuntimeRequestError {
  return new RuntimeRequestError(message, USER_CORRECTABLE_REQUEST);
}

function boundedConversationTitle(title: string): string {
  return Array.from(title.trim()).slice(0, MAX_CONVERSATION_TITLE_CHARS).join("").trim() || "Scheduled task";
}

function parseCreateInput(raw: ScheduledTaskCreateInput): ScheduledTaskCreateInput {
  const parsed = scheduledTaskCreateInputSchema.safeParse(raw);
  if (!parsed.success) throw userError(parsed.error.issues[0]?.message || "Invalid scheduled task input.");
  return parsed.data;
}

function parsePatchInput(raw: ScheduledTaskPatch): ScheduledTaskPatch {
  const parsed = scheduledTaskPatchSchema.safeParse(raw);
  if (!parsed.success) throw userError(parsed.error.issues[0]?.message || "Invalid scheduled task update.");
  return parsed.data;
}

function isTerminalTurnStatus(status: AgentTurn["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

export class ScheduledTaskService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly isUpdateHeld: () => boolean;
  private readonly inFlightTaskIds = new Set<string>();
  private readonly trackedByRunId = new Map<string, TrackedScheduledRun>();
  private readonly trackedByQueueItemId = new Map<string, string>();
  private readonly trackedByTurnId = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  private tickInProgress = false;

  constructor(private readonly dependencies: ScheduledTaskServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? (() => randomUUID());
    this.isUpdateHeld = dependencies.isUpdateHeld ?? (() => isHeld());
  }

  list(projectId?: string): ScheduledTask[] {
    return this.dependencies.repository.list(projectId);
  }

  listSummaries(projectId?: string): ScheduledTaskSummary[] {
    return this.dependencies.repository.list(projectId).map((task) => ({
      task,
      recentRuns: this.dependencies.repository.listRuns(task.id, MAX_SCHEDULED_TASK_RUN_HISTORY),
    }));
  }

  get(taskId: string): ScheduledTask | null {
    return this.dependencies.repository.get(taskId);
  }

  getSummary(taskId: string): ScheduledTaskSummary | null {
    const task = this.dependencies.repository.get(taskId);
    if (!task) return null;
    return { task, recentRuns: this.dependencies.repository.listRuns(task.id, MAX_SCHEDULED_TASK_RUN_HISTORY) };
  }

  listRuns(taskId: string, limit = MAX_SCHEDULED_TASK_RUN_HISTORY): ScheduledTaskRun[] {
    return this.dependencies.repository.listRuns(taskId, limit);
  }

  getBoundConversation(
    conversationId: string,
  ): Pick<Conversation, "id" | "projectId" | "accessMode" | "interactionMode" | "archivedAt"> | null {
    try {
      return this.dependencies.store.conversation(conversationId);
    } catch (error) {
      if (error instanceof RecordNotFoundError) return null;
      throw error;
    }
  }

  providerContentForQueueItem(queueItemId: string): string | null {
    const runId = this.trackedByQueueItemId.get(queueItemId);
    return runId ? (this.trackedByRunId.get(runId)?.providerContent ?? null) : null;
  }

  create(rawInput: ScheduledTaskCreateInput): ScheduledTask {
    const input = parseCreateInput(rawInput);
    const now = this.now();
    this.assertProjectExists(input.projectId);
    if (input.boundConversationId !== undefined && input.boundConversationId !== null) {
      this.assertValidBoundConversation(input.boundConversationId, input.projectId);
    }

    const allTasks = this.dependencies.repository.list();
    if (allTasks.length >= MAX_SCHEDULED_TASKS_TOTAL) {
      throw userError(`At most ${MAX_SCHEDULED_TASKS_TOTAL} scheduled tasks are allowed.`);
    }
    if (allTasks.filter((task) => task.projectId === input.projectId).length >= MAX_SCHEDULED_TASKS_PER_PROJECT) {
      throw userError(`At most ${MAX_SCHEDULED_TASKS_PER_PROJECT} scheduled tasks are allowed per project.`);
    }

    const enabled = input.enabled ?? true;
    const nextRunAt = enabled ? computeNextScheduledRunAt(input.schedule, now) : null;
    if (enabled && input.schedule.type === "once" && nextRunAt === null) {
      throw userError(SCHEDULED_TASK_PAST_ONCE_MESSAGE);
    }

    const task = this.dependencies.repository.create({
      ...input,
      id: input.id ?? this.createId(),
      nextRunAt,
      now: now.toISOString(),
    });
    this.broadcastChanged(task.projectId);
    this.rescheduleTimer();
    return task;
  }

  update(taskId: string, rawPatch: ScheduledTaskPatch): ScheduledTask {
    const patch = parsePatchInput(rawPatch);
    const existing = this.dependencies.repository.get(taskId);
    if (!existing) throw userError(SCHEDULED_TASK_NOT_FOUND_MESSAGE);

    const now = this.now();
    this.assertProjectExists(existing.projectId);
    const effectiveBoundId = patch.boundConversationId !== undefined
      ? patch.boundConversationId : existing.boundConversationId;
    if (patch.boundConversationId !== undefined && patch.boundConversationId !== null) {
      this.assertValidBoundConversation(patch.boundConversationId, existing.projectId);
    }

    const effectiveSchedule = patch.schedule ?? existing.schedule;
    const effectiveEnabled = patch.enabled ?? existing.enabled;
    if (effectiveEnabled && effectiveBoundId !== null) {
      this.assertValidBoundConversation(effectiveBoundId, existing.projectId);
    }

    let nextRunAt: string | null | undefined;
    if (!effectiveEnabled) {
      nextRunAt = null;
    } else if (patch.schedule !== undefined || patch.enabled === true || existing.nextRunAt === null) {
      nextRunAt = computeNextScheduledRunAt(effectiveSchedule, now);
      if (effectiveSchedule.type === "once" && nextRunAt === null) {
        throw userError(SCHEDULED_TASK_PAST_ONCE_MESSAGE);
      }
    }

    const updated = this.dependencies.repository.update(taskId, {
      ...patch,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      now: now.toISOString(),
    });
    this.broadcastChanged(updated.projectId);
    this.rescheduleTimer();
    return updated;
  }

  delete(taskId: string): boolean {
    const existing = this.dependencies.repository.get(taskId);
    if (!existing) throw userError(SCHEDULED_TASK_NOT_FOUND_MESSAGE);
    const queuedItems = new Map<string, string>();
    for (const run of this.dependencies.repository.listActiveRuns()) {
      if (run.taskId === taskId && run.conversationId && run.queueItemId) {
        queuedItems.set(run.queueItemId, run.conversationId);
      }
    }
    for (const tracked of this.trackedByRunId.values()) {
      if (tracked.taskId === taskId && tracked.conversationId && tracked.queueItemId) {
        queuedItems.set(tracked.queueItemId, tracked.conversationId);
      }
    }
    if (!this.dependencies.repository.delete(taskId)) {
      throw userError(SCHEDULED_TASK_NOT_FOUND_MESSAGE);
    }
    for (const [runId, tracked] of this.trackedByRunId) {
      if (tracked.taskId === taskId) this.untrackRun(runId);
    }
    const notifiedConversations = new Set<string>();
    for (const [queueItemId, conversationId] of queuedItems) {
      if (this.cancelQueuedScheduledItem(conversationId, queueItemId)) {
        notifiedConversations.add(conversationId);
      }
    }
    for (const conversationId of notifiedConversations) {
      this.dependencies.messageQueue?.()?.onExternalQueueChanged?.(conversationId);
    }
    this.broadcastChanged(existing.projectId);
    this.rescheduleTimer();
    return true;
  }

  onConversationDeleted(conversationId: string, projectId: string): void {
    const now = this.now();
    for (const run of this.dependencies.repository.listActiveRuns()) {
      if (run.conversationId === conversationId) {
        this.settleNonTurnRun(run, "skipped", "The run's chat was deleted.", now, false);
      }
    }
    for (const [runId, tracked] of this.trackedByRunId) {
      if (tracked.conversationId === conversationId) this.untrackRun(runId);
    }
    this.broadcastChanged(projectId);
    this.rescheduleTimer();
  }

  cancelIfStale(
    conversationId: string,
    itemId: string,
    scheduledTask: { taskId: string; runId: string },
  ): boolean {
    const task = this.dependencies.repository.get(scheduledTask.taskId);
    const run = this.dependencies.repository.getRun(scheduledTask.runId);
    const stale = !task
      || !run
      || run.taskId !== scheduledTask.taskId
      || run.state === "completed"
      || run.state === "failed"
      || run.state === "skipped";
    if (!stale) return false;
    this.untrackRun(scheduledTask.runId);
    return this.cancelQueuedScheduledItem(conversationId, itemId);
  }

  private cancelQueuedScheduledItem(conversationId: string, itemId: string): boolean {
    const queue = this.dependencies.store.orchestration?.queue;
    if (!queue?.cancel) return false;
    const item = queue.getItem?.(itemId);
    if (item && item.state !== "waiting" && item.state !== "blocked") return false;
    try {
      queue.cancel({ conversationId, itemId, reason: "withdrawn" });
      return true;
    } catch {
      return false;
    }
  }

  async runNow(taskId: string): Promise<ScheduledTaskRunNowResult> {
    if (this.isUpdateHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
    if (this.dependencies.enableProviders === false) {
      throw new RuntimeRequestError("Scheduled tasks require an available provider runtime.");
    }
    if (!this.dependencies.repository.get(taskId)) throw userError(SCHEDULED_TASK_NOT_FOUND_MESSAGE);
    if (this.inFlightTaskIds.has(taskId)) throw userError(SCHEDULED_TASK_IN_FLIGHT_MESSAGE);
    if (this.dependencies.repository.hasActiveQueuedOrRunningOccurrence(taskId)) {
      throw userError(SCHEDULED_TASK_ALREADY_RUNNING_MESSAGE);
    }

    this.inFlightTaskIds.add(taskId);
    try {
      const liveTask = this.dependencies.repository.get(taskId);
      if (!liveTask) throw userError(SCHEDULED_TASK_NOT_FOUND_MESSAGE);
      if (this.dependencies.repository.hasActiveQueuedOrRunningOccurrence(taskId)) {
        throw userError(SCHEDULED_TASK_ALREADY_RUNNING_MESSAGE);
      }
      const result = await this.claimAndDispatch(liveTask, "manual");
      if (!result) throw userError(SCHEDULED_TASK_IN_FLIGHT_MESSAGE);
      return result;
    } finally {
      this.inFlightTaskIds.delete(taskId);
      this.rescheduleTimer();
    }
  }

  bindRunTurn(runIdOrQueueItemId: string, turnId: string): ScheduledTaskRun | null {
    const resolvedRunId = this.trackedByQueueItemId.get(runIdOrQueueItemId) ?? runIdOrQueueItemId;
    const existing = this.dependencies.repository.getRun(resolvedRunId);
    if (!existing || existing.state === "completed" || existing.state === "failed" || existing.state === "skipped") {
      return null;
    }

    const nowIso = this.now().toISOString();
    const tracked = this.trackedByRunId.get(existing.id);
    if (tracked) tracked.turnId = turnId;
    this.trackedByTurnId.set(turnId, existing.id);
    const updatedRun = this.dependencies.repository.updateRun(existing.id, {
      state: "running", turnId, updatedAt: nowIso,
    });
    const task = this.dependencies.repository.get(existing.taskId);
    if (task) {
      this.dependencies.repository.update(task.id, {
        now: nowIso,
        lastRunStatus: "running",
        ...(existing.conversationId ? { lastConversationId: existing.conversationId } : {}),
        lastTurnId: turnId,
      });
      this.broadcastChanged(task.projectId);
    }
    const existingTurn = this.readTurnOrNull(turnId);
    if (existingTurn && isTerminalTurnStatus(existingTurn.status)) {
      this.onTurnSettled(existingTurn);
      return this.dependencies.repository.getRun(existing.id) ?? updatedRun;
    }
    return updatedRun;
  }

  onRunQueueCancelled(runId: string, reason: string): void {
    const run = this.dependencies.repository.getRun(runId);
    if (!run || run.state === "completed" || run.state === "failed" || run.state === "skipped" || run.state === "running") {
      return;
    }
    const queueItem = run.queueItemId
      ? this.dependencies.store.orchestration?.queue?.getItem?.(run.queueItemId) ?? null
      : null;
    const nextState: ScheduledTaskRunStatus = queueItem?.state === "blocked" ? "failed" : "skipped";
    this.settleNonTurnRun(run, nextState, reason, this.now());
  }

  onTurnSettled(
    turn: Pick<AgentTurn, "id" | "conversationId" | "status" | "terminalReason" | "completedAt" | "updatedAt">,
  ): void {
    if (!isTerminalTurnStatus(turn.status)) return;
    const run = this.resolveRunForTurn(turn);
    if (!run) return;
    if (run.state === "completed" || run.state === "failed" || run.state === "skipped") {
      this.untrackRun(run.id);
      return;
    }

    const now = this.now();
    const settledAt = turn.completedAt ?? turn.updatedAt ?? now.toISOString();
    const claimedMs = Date.parse(run.claimedAt);
    const withinWindow = Number.isFinite(claimedMs)
      && (now.getTime() - claimedMs) <= SCHEDULED_TASK_FAILURE_TRACKING_WINDOW_MS;
    const succeeded = turn.status === "completed";
    const errorMessage = succeeded
      ? null
      : normalizeScheduledTaskError(turn.terminalReason ?? `Scheduled run ${turn.status}.`);

    this.dependencies.repository.updateRun(run.id, {
      state: succeeded ? "completed" : "failed",
      conversationId: turn.conversationId,
      turnId: turn.id,
      error: errorMessage,
      finishedAt: settledAt,
      updatedAt: settledAt,
    });
    this.untrackRun(run.id);

    const task = this.dependencies.repository.get(run.taskId);
    if (!task) return;
    if (withinWindow) {
      this.dependencies.repository.recordTaskOutcome(task.id, {
        lastRunAt: settledAt,
        lastRunStatus: succeeded ? "completed" : "failed",
        lastConversationId: turn.conversationId,
        lastTurnId: turn.id,
        lastError: errorMessage,
        consecutiveFailures: succeeded ? 0 : task.consecutiveFailures + 1,
        updatedAt: settledAt,
      });
    }
    this.broadcastChanged(task.projectId);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;

    const now = this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const affectedProjects = new Set<string>();

    for (const run of this.dependencies.repository.listActiveRuns()) {
      const projectId = this.reconcileActiveRunOnBoot(run, now);
      if (projectId) affectedProjects.add(projectId);
    }
    for (const taskId of this.dependencies.repository.disableTasksForMissingOrArchivedTarget(nowIso)) {
      const task = this.dependencies.repository.get(taskId);
      if (task) affectedProjects.add(task.projectId);
    }
    for (const task of this.dependencies.repository.list()) {
      if (!task.enabled || task.nextRunAt === null) continue;
      const dueMs = Date.parse(task.nextRunAt);
      if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;
      if (task.schedule.type === "once") {
        this.dependencies.repository.update(task.id, {
          enabled: false,
          nextRunAt: null,
          now: nowIso,
          lastRunAt: nowIso,
          lastRunStatus: "skipped",
          lastError: SCHEDULED_TASK_MISSED_BOOT_ERROR,
        });
      } else {
        this.dependencies.repository.update(task.id, {
          nextRunAt: computeNextScheduledRunAt(task.schedule, now),
          now: nowIso,
        });
      }
      affectedProjects.add(task.projectId);
    }

    for (const projectId of affectedProjects) this.broadcastChanged(projectId);
    this.rescheduleTimer();
  }

  async tick(): Promise<void> {
    if (this.disposed || this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      if (this.isUpdateHeld() || this.dependencies.enableProviders === false) return;
      const dueTasks = this.dependencies.repository.listDue(this.now().toISOString(), MAX_DUE_PER_TICK);
      for (const task of dueTasks) {
        if (this.disposed || this.isUpdateHeld()) break;
        if (!task.enabled || this.inFlightTaskIds.has(task.id)) continue;

        this.inFlightTaskIds.add(task.id);
        try {
          const liveTask = this.dependencies.repository.get(task.id);
          if (!liveTask || !liveTask.enabled || liveTask.nextRunAt === null) continue;
          if (Date.parse(liveTask.nextRunAt) > this.now().getTime()) continue;

          if (
            liveTask.schedule.type !== "once"
            && this.dependencies.repository.hasActiveQueuedOrRunningOccurrence(liveTask.id)
          ) {
            const skipNow = this.now();
            this.dependencies.repository.update(liveTask.id, {
              nextRunAt: computeNextScheduledRunAt(liveTask.schedule, skipNow),
              now: skipNow.toISOString(),
            });
            this.broadcastChanged(liveTask.projectId);
            continue;
          }
          try {
            await this.claimAndDispatch(liveTask, "schedule");
          } catch {
            // Failure already persisted on run and task; keep draining remaining due tasks.
          }
        } finally {
          this.inFlightTaskIds.delete(task.id);
        }
      }
    } finally {
      this.tickInProgress = false;
      this.rescheduleTimer();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.trackedByRunId.clear();
    this.trackedByQueueItemId.clear();
    this.trackedByTurnId.clear();
  }

  private rescheduleTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.started || this.disposed) return;

    let earliestMs: number | null = null;
    for (const task of this.dependencies.repository.list()) {
      if (!task.enabled || task.nextRunAt === null) continue;
      const ms = Date.parse(task.nextRunAt);
      if (Number.isFinite(ms) && (earliestMs === null || ms < earliestMs)) earliestMs = ms;
    }
    if (earliestMs === null) return;

    const rawDelay = earliestMs - this.now().getTime();
    const delayMs = this.isUpdateHeld() && rawDelay <= 0
      ? UPDATE_HOLD_RETRY_DELAY_MS
      : Math.max(0, Math.min(MAX_TIMER_DELAY_MS, rawDelay));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => undefined);
    }, delayMs);
    this.timer.unref?.();
  }

  private async claimAndDispatch(
    task: ScheduledTask,
    trigger: ScheduledTaskRunTrigger,
  ): Promise<ScheduledTaskRunNowResult | null> {
    const now = this.now();
    const nowIso = now.toISOString();
    const runId = this.createId();
    const isOnce = task.schedule.type === "once";
    const claimKey = trigger === "schedule"
      ? `sched:${task.id}:${task.nextRunAt ?? nowIso}`
      : `manual:${task.id}:${runId}`;
    const nextRunAtAfterClaim = isOnce
      ? null
      : trigger === "schedule"
        ? computeNextScheduledRunAt(task.schedule, now)
        : (task.enabled ? task.nextRunAt : null);

    const claimed = this.dependencies.repository.claimRun({
      runId,
      taskId: task.id,
      claimKey,
      trigger,
      scheduledFor: trigger === "schedule" ? task.nextRunAt : null,
      claimedAt: nowIso,
      nextRunAtAfterClaim,
      disableTaskAfterClaim: isOnce,
    });
    if (!claimed) return null;

    let targetConversationId: string | null = null;
    try {
      const resolved = await this.resolveTargetConversation(task, claimed, nowIso);
      targetConversationId = resolved.conversationId;
      const freshTask = this.dependencies.repository.get(task.id) ?? task;
      const providerContent = withAgentSenderNote(freshTask.prompt, {
        conversationId: freshTask.id, title: freshTask.title, kind: "scheduled",
      });
      const dispatched = await this.dispatchToQueue({
        task: freshTask,
        run: claimed,
        conversationId: resolved.conversationId,
        content: freshTask.prompt,
        providerContent,
        modelSelection: freshTask.modelSelection,
        followsThreadSelection: freshTask.modelSelection === null,
        freshContext: resolved.freshContext,
        queueItemId: this.createId(),
        requestedAt: nowIso,
      });

      const updatedAt = this.now().toISOString();
      const updatedRun = dispatched.linkedRun
        ?? this.dependencies.repository.updateRun(claimed.id, {
          state: "queued",
          conversationId: resolved.conversationId,
          queueItemId: dispatched.queueItemId,
          ...(dispatched.turnId ? { turnId: dispatched.turnId } : {}),
          updatedAt,
        })
        ?? {
          ...claimed,
          state: "queued" as const,
          conversationId: resolved.conversationId,
          queueItemId: dispatched.queueItemId,
          turnId: dispatched.turnId ?? null,
        };
      const updatedTask = dispatched.linkedTask
        ?? this.dependencies.repository.update(freshTask.id, {
          now: updatedAt,
          lastRunAt: updatedAt,
          lastRunStatus: "queued",
          lastConversationId: resolved.conversationId,
          ...(dispatched.turnId ? { lastTurnId: dispatched.turnId } : {}),
        });
      this.trackRun({
        runId: updatedRun.id,
        taskId: freshTask.id,
        conversationId: resolved.conversationId,
        queueItemId: dispatched.queueItemId,
        turnId: dispatched.turnId ?? null,
        claimedAt: updatedRun.claimedAt,
        providerContent,
      });
      this.broadcastChanged(updatedTask.projectId);
      return { task: updatedTask, run: updatedRun, conversationId: resolved.conversationId };
    } catch (error) {
      const failNow = this.now().toISOString();
      const message = normalizeScheduledTaskError(error);
      const disableMissingTarget = error instanceof MissingOrArchivedTargetError;
      this.dependencies.repository.updateRun(claimed.id, {
        state: "failed", conversationId: targetConversationId, error: message, finishedAt: failNow, updatedAt: failNow,
      });
      const currentTask = this.dependencies.repository.get(task.id) ?? task;
      const nextFailures = currentTask.consecutiveFailures + 1;
      if (disableMissingTarget) {
        this.dependencies.repository.update(task.id, {
          enabled: false,
          nextRunAt: null,
          now: failNow,
          lastRunAt: failNow,
          lastRunStatus: "failed",
          lastConversationId: targetConversationId,
          lastTurnId: null,
          lastError: message,
          consecutiveFailures: nextFailures,
        });
      } else {
        this.dependencies.repository.recordTaskOutcome(task.id, {
          lastRunAt: failNow,
          lastRunStatus: "failed",
          lastConversationId: targetConversationId,
          lastTurnId: null,
          lastError: message,
          consecutiveFailures: nextFailures,
          updatedAt: failNow,
        });
      }
      this.broadcastChanged(task.projectId);
      if (disableMissingTarget) throw userError(message);
      throw error;
    }
  }

  private async resolveTargetConversation(
    task: ScheduledTask,
    run: ScheduledTaskRun,
    nowIso: string,
  ): Promise<{ conversationId: string; freshContext: boolean }> {
    if (task.boundConversationId !== null) {
      const conversation = this.readBoundConversationOrThrow(task.boundConversationId, task.projectId);
      return { conversationId: conversation.id, freshContext: task.freshSession };
    }
    const created = await this.dependencies.createConversation({
      projectId: task.projectId,
      title: boundedConversationTitle(task.title),
      modelSelection: task.modelSelection,
      interactionMode: task.interactionMode,
      accessMode: task.accessMode,
      requestId: `scheduled-task:${task.id}:${run.id}`,
    });
    if (task.freshSession) {
      this.dependencies.repository.update(task.id, { boundConversationId: created.id, now: nowIso });
    }
    return { conversationId: created.id, freshContext: task.freshSession };
  }

  private async dispatchToQueue(
    input: ScheduledTaskEnqueuePromptInput,
  ): Promise<ScheduledTaskEnqueuePromptResult> {
    if (this.dependencies.enqueueScheduledPrompt) {
      return await this.dependencies.enqueueScheduledPrompt(input);
    }
    const queue = this.dependencies.store.orchestration?.queue;
    if (!queue) throw new RuntimeRequestError("Message queue is unavailable for scheduled task dispatch.");
    let linkedRun: ScheduledTaskRun | null = null;
    let linkedTask: ScheduledTask | null = null;
    queue.enqueue({
      conversationId: input.conversationId,
      itemId: input.queueItemId,
      content: input.content,
      kind: "message",
      createdBy: "system",
      creationSource: "server",
      ...(input.followsThreadSelection
        ? { followsThreadSelection: true as const }
        : { modelSelection: input.modelSelection }),
      ...(input.freshContext ? { freshContext: true as const } : {}),
      requestedAt: input.requestedAt,
      attribution: {
        scheduledTask: {
          taskId: input.task.id,
          runId: input.run.id,
          title: boundedConversationTitle(input.task.title),
          interactionMode: input.task.interactionMode,
          accessMode: input.task.accessMode,
        },
      },
      origin: "automatic",
      commandType: "scheduled-task.dispatch",
      source: {
        actorId: "runtime",
        commandId: `scheduled-run:${input.run.id}`,
        command: {
          type: "scheduled-task.dispatch",
          taskId: input.task.id,
          runId: input.run.id,
          conversationId: input.conversationId,
          queueItemId: input.queueItemId,
          content: { chars: queueContentCharCount(input.content.trim()) },
        },
      },
      afterInsert: () => {
        linkedRun = this.dependencies.repository.updateRun(input.run.id, {
          state: "queued",
          conversationId: input.conversationId,
          queueItemId: input.queueItemId,
          updatedAt: input.requestedAt,
        });
        linkedTask = this.dependencies.repository.update(input.task.id, {
          now: input.requestedAt,
          lastRunAt: input.requestedAt,
          lastRunStatus: "queued",
          lastConversationId: input.conversationId,
        });
      },
    });
    void Promise.resolve(this.dependencies.messageQueue?.()?.schedule?.(input.conversationId)).catch(() => undefined);
    return {
      queueItemId: input.queueItemId,
      ...(linkedRun ? { linkedRun } : {}),
      ...(linkedTask ? { linkedTask } : {}),
    };
  }

  private assertProjectExists(projectId: string): void {
    try {
      this.dependencies.store.project(projectId);
    } catch (error) {
      if (error instanceof RecordNotFoundError) throw userError(SCHEDULED_TASK_PROJECT_MISSING_MESSAGE);
      throw error;
    }
  }

  private assertValidBoundConversation(conversationId: string, projectId: string): void {
    try {
      this.readBoundConversationOrThrow(conversationId, projectId);
    } catch (error) {
      if (error instanceof MissingOrArchivedTargetError) throw userError(error.message);
      throw error;
    }
  }

  private readBoundConversationOrThrow(
    conversationId: string,
    projectId: string,
  ): ReturnType<ScheduledTaskStoreLike["conversation"]> {
    let conversation: ReturnType<ScheduledTaskStoreLike["conversation"]>;
    try {
      conversation = this.dependencies.store.conversation(conversationId);
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        throw new MissingOrArchivedTargetError(SCHEDULED_TASK_BOUND_CHAT_MISSING_MESSAGE);
      }
      throw error;
    }
    if (conversation.projectId !== projectId) {
      throw new MissingOrArchivedTargetError(SCHEDULED_TASK_BOUND_CHAT_PROJECT_MESSAGE);
    }
    if (conversation.archivedAt !== null) {
      throw new MissingOrArchivedTargetError(SCHEDULED_TASK_BOUND_CHAT_ARCHIVED_MESSAGE);
    }
    return conversation;
  }

  private readTurnOrNull(
    turnId: string,
  ): Pick<AgentTurn, "id" | "conversationId" | "status" | "terminalReason" | "completedAt" | "updatedAt"> | null {
    if (!this.dependencies.store.agentTurn) return null;
    try {
      return this.dependencies.store.agentTurn(turnId);
    } catch (error) {
      if (error instanceof RecordNotFoundError) return null;
      throw error;
    }
  }

  private settleNonTurnRun(
    run: ScheduledTaskRun,
    state: "failed" | "skipped",
    reason: string,
    now: Date,
    broadcast = true,
  ): string | null {
    const nowIso = now.toISOString();
    const errorMessage = normalizeScheduledTaskError(reason);
    this.dependencies.repository.updateRun(run.id, {
      state,
      error: errorMessage,
      finishedAt: nowIso,
      updatedAt: nowIso,
    });
    this.untrackRun(run.id);
    const task = this.dependencies.repository.get(run.taskId);
    if (!task) return null;
    const claimedMs = Date.parse(run.claimedAt);
    const withinWindow = Number.isFinite(claimedMs)
      && (now.getTime() - claimedMs) <= SCHEDULED_TASK_FAILURE_TRACKING_WINDOW_MS;
    if (withinWindow) {
      this.dependencies.repository.recordTaskOutcome(task.id, {
        lastRunAt: nowIso,
        lastRunStatus: state,
        lastConversationId: run.conversationId,
        lastTurnId: run.turnId,
        lastError: errorMessage,
        consecutiveFailures: state === "failed" ? task.consecutiveFailures + 1 : task.consecutiveFailures,
        updatedAt: nowIso,
      });
    }
    if (broadcast) this.broadcastChanged(task.projectId);
    return task.projectId;
  }

  private reconcileActiveRunOnBoot(run: ScheduledTaskRun, now: Date): string | null {
    const getQueueItem = this.dependencies.store.orchestration?.queue?.getItem;
    const queueItem = run.queueItemId && getQueueItem ? getQueueItem.call(this.dependencies.store.orchestration!.queue, run.queueItemId) : null;
    if (run.state === "claimed") {
      if (!run.queueItemId || (getQueueItem && !queueItem)) {
        return this.settleNonTurnRun(run, "failed", SCHEDULED_TASK_STRANDED_BOOT_ERROR, now, false);
      }
      return null;
    }
    if (run.state === "queued") {
      if (!run.queueItemId) {
        return this.settleNonTurnRun(run, "failed", "The queued scheduled prompt is missing its queue reference.", now, false);
      }
      if (!getQueueItem) return null;
      if (!queueItem) {
        return this.settleNonTurnRun(run, "failed", "The queued scheduled prompt is no longer in the chat queue.", now, false);
      }
      if (queueItem.state === "cancelled") {
        return this.settleNonTurnRun(run, "skipped", queueItem.detail ?? "The queued scheduled prompt was cancelled.", now, false);
      }
      if (queueItem.state === "blocked") {
        return this.settleNonTurnRun(run, "failed", queueItem.detail ?? "The queued scheduled prompt was blocked.", now, false);
      }
      if (queueItem.state === "delivered" && queueItem.delivery?.turnId) {
        const bound = this.bindRunTurn(run.id, queueItem.delivery.turnId);
        if (!bound) return this.dependencies.repository.get(run.taskId)?.projectId ?? null;
        if (bound.state === "completed" || bound.state === "failed" || bound.state === "skipped") {
          return this.dependencies.repository.get(run.taskId)?.projectId ?? null;
        }
        return this.reconcileRunningRunOnBoot(bound, now);
      }
      return null;
    }
    if (run.state === "running") {
      return this.reconcileRunningRunOnBoot(run, now);
    }
    return null;
  }

  private reconcileRunningRunOnBoot(run: ScheduledTaskRun, now: Date): string | null {
    if (!run.turnId) {
      return this.settleNonTurnRun(run, "failed", "The scheduled run is missing its turn reference after restart.", now, false);
    }
    if (!this.dependencies.store.agentTurn) return null;
    const turn = this.readTurnOrNull(run.turnId);
    if (!turn) {
      return this.settleNonTurnRun(run, "failed", "The scheduled run's turn no longer exists.", now, false);
    }
    if (isTerminalTurnStatus(turn.status)) {
      this.onTurnSettled(turn);
      return this.dependencies.repository.get(run.taskId)?.projectId ?? null;
    }
    this.trackRun({
      runId: run.id,
      taskId: run.taskId,
      conversationId: run.conversationId ?? turn.conversationId,
      queueItemId: run.queueItemId ?? run.id,
      turnId: run.turnId,
      claimedAt: run.claimedAt,
      providerContent: "",
    });
    return null;
  }

  private resolveRunForTurn(turn: Pick<AgentTurn, "id">): ScheduledTaskRun | null {
    const byTurn = this.dependencies.repository.findRunByTurnId(turn.id);
    if (byTurn) return byTurn;
    const trackedRunId = this.trackedByTurnId.get(turn.id);
    if (trackedRunId) {
      const found = this.dependencies.repository.getRun(trackedRunId);
      if (found && found.turnId === turn.id) return found;
    }
    return null;
  }

  private trackRun(tracked: TrackedScheduledRun): void {
    this.trackedByRunId.set(tracked.runId, tracked);
    this.trackedByQueueItemId.set(tracked.queueItemId, tracked.runId);
    if (tracked.turnId) this.trackedByTurnId.set(tracked.turnId, tracked.runId);
  }

  private untrackRun(runId: string): void {
    const tracked = this.trackedByRunId.get(runId);
    if (!tracked) return;
    this.trackedByRunId.delete(runId);
    this.trackedByQueueItemId.delete(tracked.queueItemId);
    if (tracked.turnId) this.trackedByTurnId.delete(tracked.turnId);
  }

  private broadcastChanged(projectId: string): void {
    this.dependencies.broadcast({ type: "scheduled-tasks.changed", projectId });
  }
}
