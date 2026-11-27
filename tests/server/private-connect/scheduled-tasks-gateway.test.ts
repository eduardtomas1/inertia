// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import {
  handlePrivateConnectScheduledTaskRequest,
  isPrivateConnectRuntimeScheduledTaskRequest,
  projectPrivateConnectScheduledTask,
  type PrivateConnectScheduledTaskGatewayHandlers,
} from "../../../src/server/private-connect/scheduled-tasks-gateway";
import {
  RuntimeRequestError,
  USER_CORRECTABLE_REQUEST,
} from "../../../src/server/runtime-errors";
import {
  privateConnectRuntimeResponseSchema,
  privateConnectScheduledTaskSchema,
  type PrivateConnectRuntimeAuthorization,
} from "../../../src/shared/private-connect/runtime-contract";
import { privateConnectRuntimeGrantsFromProjectIds } from "../../../src/shared/private-connect/runtime-grants";
import type { ScheduledTask } from "../../../src/shared/scheduled-tasks";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ALLOWED_ID = "44444444-4444-4444-8444-444444444444";
const TASK_FOREIGN_ID = "55555555-5555-4555-8555-555555555555";
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";

function makeSubject(
  scopes: PrivateConnectRuntimeAuthorization["scopes"],
  projectIds: string[] = ["proj-allowed"],
): PrivateConnectRuntimeAuthorization {
  return {
    deviceId: DEVICE_ID,
    sessionId: SESSION_ID,
    scopes,
    projectIds,
    grants: privateConnectRuntimeGrantsFromProjectIds(projectIds),
    grantVersion: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: TASK_ALLOWED_ID,
    projectId: "proj-allowed",
    title: "Nightly test sweep",
    prompt: "TOP_SECRET_PROMPT_BODY: run tests with sk-live-secret1234567890",
    schedule: { type: "fixed_time", timeOfDay: "09:30", weekdays: [1, 2, 3, 4, 5] },
    boundConversationId: CONVERSATION_ID,
    freshSession: false,
    modelSelection: null,
    interactionMode: "build",
    accessMode: "supervised",
    enabled: true,
    nextRunAt: "2027-01-02T09:30:00.000Z",
    lastRunAt: "2027-01-01T09:30:00.000Z",
    lastRunStatus: "completed",
    lastConversationId: CONVERSATION_ID,
    lastTurnId: "turn-1",
    lastError: null,
    consecutiveFailures: 0,
    createdBy: "user",
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T09:30:00.000Z",
    ...overrides,
  };
}

function makeHandlers(tasks: ScheduledTask[]): {
  handlers: PrivateConnectScheduledTaskGatewayHandlers;
  spies: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    projectName: ReturnType<typeof vi.fn>;
    toggle: ReturnType<typeof vi.fn>;
    runNow: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
} {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const list = vi.fn((projectId?: string) => (
    projectId ? tasks.filter((task) => task.projectId === projectId) : [...tasks]
  ));
  const get = vi.fn((taskId: string) => byId.get(taskId) ?? null);
  const projectName = vi.fn((projectId: string) => (
    projectId === "proj-allowed" ? "Allowed Repo" : "Secret Repo"
  ));
  const toggle = vi.fn(async (taskId: string, enabled: boolean) => {
    const found = byId.get(taskId)!;
    const updated = { ...found, enabled };
    byId.set(taskId, updated);
    return updated;
  });
  const runNow = vi.fn(async (taskId: string) => {
    const found = byId.get(taskId)!;
    const updated = { ...found, lastRunStatus: "queued" as const };
    byId.set(taskId, updated);
    return { task: updated, conversationId: CONVERSATION_ID };
  });
  const remove = vi.fn(async (taskId: string) => byId.delete(taskId));
  return {
    handlers: { list, get, projectName, toggle, runNow, remove },
    spies: { list, get, projectName, toggle, runNow, remove },
  };
}

describe("Private Connect scheduled tasks gateway", () => {
  it("identifies scheduled task requests with the type guard", () => {
    expect(isPrivateConnectRuntimeScheduledTaskRequest({
      type: "scheduled-tasks.list",
      requestId: REQUEST_ID,
    })).toBe(true);
    expect(isPrivateConnectRuntimeScheduledTaskRequest({
      type: "scheduled-task.toggle",
      requestId: REQUEST_ID,
      taskId: TASK_ALLOWED_ID,
      enabled: false,
    })).toBe(true);
    expect(isPrivateConnectRuntimeScheduledTaskRequest({
      type: "scheduled-task.run-now",
      requestId: REQUEST_ID,
      taskId: TASK_ALLOWED_ID,
    })).toBe(true);
    expect(isPrivateConnectRuntimeScheduledTaskRequest({
      type: "scheduled-task.delete",
      requestId: REQUEST_ID,
      taskId: TASK_ALLOWED_ID,
    })).toBe(true);
    expect(isPrivateConnectRuntimeScheduledTaskRequest({
      type: "state.get",
      requestId: REQUEST_ID,
    })).toBe(false);
  });

  it("allows Monitor devices to list tasks for granted projects only and hides other projects", async () => {
    const allowedTask = makeTask();
    const foreignTask = makeTask({
      id: TASK_FOREIGN_ID,
      projectId: "proj-secret",
      title: "Secret payroll sync",
    });
    const { handlers } = makeHandlers([allowedTask, foreignTask]);
    // Even if handlers.list returns all tasks unfiltered, the gateway filters strictly.
    handlers.list = vi.fn(() => [allowedTask, foreignTask]);

    const response = await handlePrivateConnectScheduledTaskRequest(
      makeSubject(["view"], ["proj-allowed"]),
      { type: "scheduled-tasks.list", requestId: REQUEST_ID },
      handlers,
    );

    const parsed = privateConnectRuntimeResponseSchema.parse(response);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.result.kind !== "scheduled-tasks") return;
    expect(parsed.result.tasks).toHaveLength(1);
    expect(parsed.result.tasks[0]?.id).toBe(TASK_ALLOWED_ID);
    expect(parsed.result.tasks[0]?.projectName).toBe("Allowed Repo");
    expect(parsed.result.tasks[0]?.scheduleLabel).toBe("Weekdays at 09:30");
    expect(JSON.stringify(parsed)).not.toContain("Secret payroll sync");
    expect(JSON.stringify(parsed)).not.toContain("TOP_SECRET_PROMPT_BODY");
  });

  it("rejects listing an ungranted projectId with forbidden without calling list", async () => {
    const { handlers, spies } = makeHandlers([makeTask()]);

    const response = await handlePrivateConnectScheduledTaskRequest(
      makeSubject(["view"], ["proj-allowed"]),
      { type: "scheduled-tasks.list", requestId: REQUEST_ID, projectId: "proj-secret" },
      handlers,
    );

    const parsed = privateConnectRuntimeResponseSchema.parse(response);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("forbidden");
    expect(spies.list).not.toHaveBeenCalled();
  });

  it("caps listed tasks at 200 items", async () => {
    const manyTasks = Array.from({ length: 240 }, (_, index) => makeTask({
      id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
      title: `Task ${index}`,
    }));
    const { handlers } = makeHandlers(manyTasks);

    const response = await handlePrivateConnectScheduledTaskRequest(
      makeSubject(["view"], ["proj-allowed"]),
      { type: "scheduled-tasks.list", requestId: REQUEST_ID },
      handlers,
    );

    const parsed = privateConnectRuntimeResponseSchema.parse(response);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.result.kind !== "scheduled-tasks") return;
    expect(parsed.result.tasks).toHaveLength(200);
  });

  it("rejects toggle, run-now, and delete for Monitor devices with forbidden", async () => {
    const { handlers, spies } = makeHandlers([makeTask()]);
    const monitor = makeSubject(["view"], ["proj-allowed"]);

    const toggleRes = await handlePrivateConnectScheduledTaskRequest(
      monitor,
      { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID, enabled: false },
      handlers,
    );
    const runRes = await handlePrivateConnectScheduledTaskRequest(
      monitor,
      { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
      handlers,
    );
    const deleteRes = await handlePrivateConnectScheduledTaskRequest(
      monitor,
      { type: "scheduled-task.delete", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
      handlers,
    );

    for (const res of [toggleRes, runRes, deleteRes]) {
      const parsed = privateConnectRuntimeResponseSchema.parse(res);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("forbidden");
    }
    expect(spies.get).not.toHaveBeenCalled();
    expect(spies.toggle).not.toHaveBeenCalled();
    expect(spies.runNow).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it("allows Collaborate devices to toggle, run-now, and delete tasks in granted projects", async () => {
    const { handlers, spies } = makeHandlers([makeTask()]);
    const collaborator = makeSubject(["view", "prompt"], ["proj-allowed"]);

    const toggleRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        collaborator,
        { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID, enabled: false },
        handlers,
      ),
    );
    expect(toggleRes.ok).toBe(true);
    if (toggleRes.ok && toggleRes.result.kind === "scheduled-task.updated") {
      expect(toggleRes.result.task.enabled).toBe(false);
    }
    expect(spies.toggle).toHaveBeenCalledWith(TASK_ALLOWED_ID, false);

    const runRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        collaborator,
        { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
        handlers,
      ),
    );
    expect(runRes.ok).toBe(true);
    if (runRes.ok && runRes.result.kind === "scheduled-task.ran") {
      expect(runRes.result.conversationId).toBe(CONVERSATION_ID);
      expect(runRes.result.task.lastRunStatus).toBe("queued");
    }
    expect(spies.runNow).toHaveBeenCalledWith(TASK_ALLOWED_ID);

    const deleteRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        collaborator,
        { type: "scheduled-task.delete", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
        handlers,
      ),
    );
    expect(deleteRes.ok).toBe(true);
    if (deleteRes.ok && deleteRes.result.kind === "scheduled-task.deleted") {
      expect(deleteRes.result.taskId).toBe(TASK_ALLOWED_ID);
    }
    expect(spies.remove).toHaveBeenCalledWith(TASK_ALLOWED_ID);
  });

  it("returns not-found without leaking existence for tasks in ungranted projects", async () => {
    const foreignTask = makeTask({ id: TASK_FOREIGN_ID, projectId: "proj-secret" });
    const { handlers, spies } = makeHandlers([foreignTask]);
    const collaborator = makeSubject(["view", "prompt"], ["proj-allowed"]);

    const toggleRes = await handlePrivateConnectScheduledTaskRequest(
      collaborator,
      { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: TASK_FOREIGN_ID, enabled: false },
      handlers,
    );
    const runRes = await handlePrivateConnectScheduledTaskRequest(
      collaborator,
      { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: TASK_FOREIGN_ID },
      handlers,
    );
    const deleteRes = await handlePrivateConnectScheduledTaskRequest(
      collaborator,
      { type: "scheduled-task.delete", requestId: REQUEST_ID, taskId: TASK_FOREIGN_ID },
      handlers,
    );

    for (const res of [toggleRes, runRes, deleteRes]) {
      const parsed = privateConnectRuntimeResponseSchema.parse(res);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("not-found");
    }
    expect(spies.toggle).not.toHaveBeenCalled();
    expect(spies.runNow).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it("sanitizes titles, project names, errors, strips raw paths/control chars, and never leaks prompt text", () => {
    const dirtyTask = makeTask({
      title: `Deploy \u0007\u001b[31m/Users/alice/private/repo\u202e ${"x".repeat(300)}`,
      prompt: "SUPER_SENSITIVE_PROMPT_SHOULD_NEVER_APPEAR",
      lastError: `Failed reading /home/alice/secrets/.env\n\u0000\u0007 Bearer secret-token-value ${"e".repeat(400)}`,
    });

    const projected = privateConnectScheduledTaskSchema.parse(
      projectPrivateConnectScheduledTask(
        dirtyTask,
        `Repo \u0000/Users/alice/workspace ${"p".repeat(300)}`,
      ),
    );

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("SUPER_SENSITIVE_PROMPT_SHOULD_NEVER_APPEAR");
    expect(serialized).not.toContain("/Users/alice/private/repo");
    expect(serialized).not.toContain("/home/alice/secrets/.env");
    expect(serialized).not.toContain("/Users/alice/workspace");
    expect(serialized).not.toContain("secret-token-value");
    expect(projected).not.toHaveProperty("prompt");
    expect(projected.title.length).toBeLessThanOrEqual(240);
    expect(projected.projectName.length).toBeLessThanOrEqual(240);
    expect(projected.scheduleLabel.length).toBeLessThanOrEqual(240);
    expect(projected.lastError).not.toBeNull();
    expect(projected.lastError!.length).toBeLessThanOrEqual(300);
    expect(/[\u0000-\u001f\u007f\u202e]/u.test(projected.title)).toBe(false);
    expect(/[\u0000-\u001f\u007f\u202e]/u.test(projected.lastError!)).toBe(false);
  });

  it("maps RuntimeRequestError and thrown errors to sanitized error codes within 300 chars", async () => {
    const collaborator = makeSubject(["view", "prompt"], ["proj-allowed"]);
    const { handlers } = makeHandlers([makeTask()]);

    handlers.runNow = vi.fn(async () => {
      throw new RuntimeRequestError("Task is already running in /Users/alice/work", "busy");
    });
    const busyRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        collaborator,
        { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
        handlers,
      ),
    );
    expect(busyRes.ok).toBe(false);
    if (!busyRes.ok) {
      expect(busyRes.code).toBe("busy");
      expect(busyRes.message).not.toContain("/Users/alice/work");
      expect(busyRes.message.length).toBeLessThanOrEqual(300);
    }

    handlers.toggle = vi.fn(async () => {
      throw new RuntimeRequestError("Invalid schedule state", USER_CORRECTABLE_REQUEST);
    });
    const invalidRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        collaborator,
        { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID, enabled: true },
        handlers,
      ),
    );
    expect(invalidRes.ok).toBe(false);
    if (!invalidRes.ok) expect(invalidRes.code).toBe("invalid");

    handlers.remove = vi.fn(async () => {
      throw new Error(`Boom \u0007 at /var/private/db.sqlite ${"z".repeat(500)}`);
    });
    const unavailableRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        collaborator,
        { type: "scheduled-task.delete", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
        handlers,
      ),
    );
    expect(unavailableRes.ok).toBe(false);
    if (!unavailableRes.ok) {
      expect(unavailableRes.code).toBe("unavailable");
      expect(unavailableRes.message).not.toContain("/var/private/db.sqlite");
      expect(/[\u0000-\u001f\u007f]/u.test(unavailableRes.message)).toBe(false);
      expect(unavailableRes.message.length).toBeLessThanOrEqual(300);
    }
  });
});
