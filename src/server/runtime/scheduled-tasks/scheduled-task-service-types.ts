import type {
  AgentTurn, Conversation, ModelSelection, Project, RuntimeMutationEvent,
} from "../../../shared/contracts";
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskPatch,
  ScheduledTaskRun,
  ScheduledTaskRunStatus,
  ScheduledTaskRunTrigger,
} from "../../../shared/scheduled-tasks";
import type { OrchestrationQueueRepository } from "../../orchestration-v2/queue-repository";

export const MAX_TIMER_DELAY_MS = 60_000;
export const UPDATE_HOLD_RETRY_DELAY_MS = 5_000;
export const MAX_DUE_PER_TICK = 25;
export const MAX_CONVERSATION_TITLE_CHARS = 120;

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
  runInTransaction?<T>(work: () => T): T;
}

export interface ScheduledTaskStoreLike {
  project(projectId: string): Pick<Project, "id" | "name">;
  conversation(conversationId: string): Pick<Conversation, "id" | "projectId" | "title" | "archivedAt" | "accessMode" | "interactionMode" | "modelSelection">;
  agentTurn?(turnId: string): Pick<AgentTurn, "id" | "conversationId" | "status" | "terminalReason" | "completedAt" | "updatedAt">;
  orchestration?: { queue: Pick<OrchestrationQueueRepository, "enqueue"> & Partial<Pick<OrchestrationQueueRepository, "getItem" | "cancel" | "listActiveByScheduledTask">> };
}

export interface ScheduledTaskConversationCreateInput {
  projectId: string;
  title: string;
  modelSelection: ModelSelection | null;
  interactionMode: ScheduledTask["interactionMode"];
  accessMode: ScheduledTask["accessMode"];
  requestId: string;
  requirePrivateConnectPromptSafety?: boolean;
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
  requirePrivateConnectPromptSafety?: boolean;
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

export interface TrackedScheduledRun {
  runId: string;
  taskId: string;
  conversationId: string;
  queueItemId: string;
  turnId: string | null;
  claimedAt: string;
  providerContent: string;
}
