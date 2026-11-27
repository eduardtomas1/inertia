import {
  formatScheduledTaskSchedule,
  type ScheduledTask,
} from "../../shared/scheduled-tasks";
import type {
  PrivateConnectRuntimeAuthorization,
  PrivateConnectRuntimeRequest,
  PrivateConnectRuntimeResponse,
  PrivateConnectScheduledTask,
} from "../../shared/private-connect/runtime-contract";
import {
  sanitizePrivateConnectContent,
  sanitizePrivateConnectLabel,
} from "../../shared/private-connect/sanitizer";
import {
  RuntimeRequestError,
  USER_CORRECTABLE_REQUEST,
} from "../runtime-errors";

const MAX_PROJECTED_SCHEDULED_TASKS = 200;
const MAX_LABEL_CHARS = 240;
const MAX_ERROR_CHARS = 300;
const DEFAULT_ERROR_MESSAGE = "The scheduled task request could not be completed.";
const ANSI_ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

export type PrivateConnectRuntimeScheduledTaskCommand = Extract<
  PrivateConnectRuntimeRequest,
  {
    type:
      | "scheduled-tasks.list"
      | "scheduled-task.toggle"
      | "scheduled-task.run-now"
      | "scheduled-task.delete";
  }
>;

export interface PrivateConnectScheduledTaskGatewayHandlers {
  list(projectId?: string): ScheduledTask[];
  get(taskId: string): ScheduledTask | null;
  projectName(projectId: string): string | null;
  toggle(taskId: string, enabled: boolean): Promise<ScheduledTask> | ScheduledTask;
  runNow(taskId: string): Promise<{ task: ScheduledTask; conversationId: string | null }>;
  remove(taskId: string): Promise<boolean> | boolean;
}

export function isPrivateConnectRuntimeScheduledTaskCommand(
  type: PrivateConnectRuntimeRequest["type"],
): type is PrivateConnectRuntimeScheduledTaskCommand["type"] {
  return type === "scheduled-tasks.list"
    || type === "scheduled-task.toggle"
    || type === "scheduled-task.run-now"
    || type === "scheduled-task.delete";
}

export function isPrivateConnectRuntimeScheduledTaskRequest(
  request: PrivateConnectRuntimeRequest,
): request is PrivateConnectRuntimeScheduledTaskCommand {
  return isPrivateConnectRuntimeScheduledTaskCommand(request.type);
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE, " ");
}

function sanitizeErrorText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = sanitizePrivateConnectContent(stripAnsi(value).normalize("NFKC"), MAX_ERROR_CHARS)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length <= MAX_ERROR_CHARS ? cleaned : cleaned.slice(0, MAX_ERROR_CHARS).trim() || null;
}

export function projectPrivateConnectScheduledTask(
  task: ScheduledTask,
  projectName: string,
): PrivateConnectScheduledTask {
  return {
    id: task.id,
    projectId: task.projectId,
    projectName: sanitizePrivateConnectLabel(stripAnsi(projectName), MAX_LABEL_CHARS) ?? "Project",
    title: sanitizePrivateConnectLabel(stripAnsi(task.title), MAX_LABEL_CHARS) ?? "Scheduled task",
    scheduleLabel:
      sanitizePrivateConnectLabel(
        stripAnsi(formatScheduledTaskSchedule(task.schedule)),
        MAX_LABEL_CHARS,
      ) ?? "Scheduled",
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastRunStatus: task.lastRunStatus,
    lastError: sanitizeErrorText(task.lastError),
    consecutiveFailures: Math.max(0, Math.trunc(task.consecutiveFailures)),
    boundConversationId: task.boundConversationId,
  };
}

function fail(
  requestId: string,
  code: Extract<PrivateConnectRuntimeResponse, { ok: false }>["code"],
  message: string,
): PrivateConnectRuntimeResponse {
  return {
    type: "response",
    requestId,
    ok: false,
    code,
    message: sanitizeErrorText(message) ?? DEFAULT_ERROR_MESSAGE,
  };
}

function mapScheduledTaskError(
  requestId: string,
  error: unknown,
): PrivateConnectRuntimeResponse {
  if (error instanceof RuntimeRequestError) {
    const code = error.code === "busy" || /\bbusy\b|\balready running\b/iu.test(error.message)
      ? "busy"
      : error.code === "invalid" || error.code === USER_CORRECTABLE_REQUEST
        ? "invalid"
        : "unavailable";
    return fail(requestId, code, error.message);
  }
  if (error instanceof Error) {
    return fail(requestId, "unavailable", error.message);
  }
  return fail(requestId, "unavailable", DEFAULT_ERROR_MESSAGE);
}

export async function handlePrivateConnectScheduledTaskRequest(
  subject: PrivateConnectRuntimeAuthorization,
  request: PrivateConnectRuntimeScheduledTaskCommand,
  handlers: PrivateConnectScheduledTaskGatewayHandlers,
): Promise<PrivateConnectRuntimeResponse> {
  if (request.type === "scheduled-tasks.list") {
    if (!subject.scopes.includes("view")) {
      return fail(request.requestId, "forbidden", "This device cannot view scheduled tasks.");
    }
    const grantedProjectIds = new Set(subject.projectIds);
    if (request.projectId !== undefined && !grantedProjectIds.has(request.projectId)) {
      return fail(request.requestId, "forbidden", "That project is not accessible to this device.");
    }
    try {
      const tasks = handlers
        .list(request.projectId)
        .filter((task) => (
          grantedProjectIds.has(task.projectId)
          && (request.projectId === undefined || task.projectId === request.projectId)
        ))
        .slice(0, MAX_PROJECTED_SCHEDULED_TASKS)
        .map((task) => projectPrivateConnectScheduledTask(
          task,
          handlers.projectName(task.projectId) ?? "Project",
        ));
      return {
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "scheduled-tasks",
          tasks,
        },
      };
    } catch (error) {
      return mapScheduledTaskError(request.requestId, error);
    }
  }

  if (!subject.scopes.includes("view") || !subject.scopes.includes("prompt")) {
    return fail(request.requestId, "forbidden", "This device cannot modify scheduled tasks.");
  }

  let existing: ScheduledTask | null;
  try {
    existing = handlers.get(request.taskId);
  } catch (error) {
    return mapScheduledTaskError(request.requestId, error);
  }
  if (!existing || !subject.projectIds.includes(existing.projectId)) {
    return fail(request.requestId, "not-found", "That scheduled task was not found.");
  }

  try {
    if (request.type === "scheduled-task.toggle") {
      const updated = await handlers.toggle(existing.id, request.enabled);
      return {
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "scheduled-task.updated",
          task: projectPrivateConnectScheduledTask(
            updated,
            handlers.projectName(updated.projectId) ?? "Project",
          ),
        },
      };
    }

    if (request.type === "scheduled-task.run-now") {
      const ran = await handlers.runNow(existing.id);
      return {
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "scheduled-task.ran",
          task: projectPrivateConnectScheduledTask(
            ran.task,
            handlers.projectName(ran.task.projectId) ?? "Project",
          ),
          conversationId: ran.conversationId,
        },
      };
    }

    const removed = await handlers.remove(existing.id);
    if (!removed) {
      return fail(request.requestId, "not-found", "That scheduled task was not found.");
    }
    return {
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {
        kind: "scheduled-task.deleted",
        taskId: existing.id,
      },
    };
  } catch (error) {
    return mapScheduledTaskError(request.requestId, error);
  }
}
