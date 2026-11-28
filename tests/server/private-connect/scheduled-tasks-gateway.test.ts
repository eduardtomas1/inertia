// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import { PrivateConnectRuntimeGateway } from "../../../src/server/private-connect/runtime-gateway";
import {
  handlePrivateConnectScheduledTaskRequest,
  isPrivateConnectRuntimeScheduledTaskRequest,
  projectPrivateConnectScheduledTask,
  type PrivateConnectScheduledTaskGatewayContext,
  type PrivateConnectScheduledTaskGatewayHandlers,
} from "../../../src/server/private-connect/scheduled-tasks-gateway";
import {
  RuntimeRequestError,
  USER_CORRECTABLE_REQUEST,
} from "../../../src/server/runtime-errors";
import type { AppSnapshot, Conversation } from "../../../src/shared/contracts";
import {
  privateConnectPromptSafetyForHarness,
  privateConnectPromptSafetyIsUsable,
} from "../../../src/shared/private-connect/prompt-safety";
import {
  privateConnectRuntimeResponseSchema,
  privateConnectScheduledTaskSchema,
  type PrivateConnectRuntimeAuthorization,
} from "../../../src/shared/private-connect/runtime-contract";
import {
  privateConnectRuntimeGrantAllowsConversation,
  privateConnectRuntimeGrantsFromProjectIds,
  type PrivateConnectRuntimeGrant,
} from "../../../src/shared/private-connect/runtime-grants";
import type { ScheduledTask } from "../../../src/shared/scheduled-tasks";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ALLOWED_ID = "44444444-4444-4444-8444-444444444444";
const TASK_FOREIGN_ID = "55555555-5555-4555-8555-555555555555";
const TASK_OTHER_CONV_ID = "77777777-7777-4777-8777-777777777777";
const TASK_UNBOUND_ID = "88888888-8888-4888-8888-888888888888";
const TASK_ARCHIVED_ID = "99999999-9999-4999-8999-999999999999";
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_CONVERSATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARCHIVED_CONVERSATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WATCHER_CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeModelSelection(harnessId = "codex-app-server"): NonNullable<ScheduledTask["modelSelection"]> {
  return {
    harnessId,
    backendProfileId: `native:${harnessId}`,
    backendProfileDisplayName: "Default",
    modelId: "gpt-5",
    alias: null,
    reasoningEffort: "medium",
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: 1,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  const modelSelection = overrides.modelSelection ?? makeModelSelection();
  return {
    id: CONVERSATION_ID,
    projectId: "proj-allowed",
    title: "Allowed chat",
    providerId: "codex",
    modelSelection,
    continuationIdentity: null,
    model: modelSelection.modelId,
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2027-01-01T00:00:00.000Z",
    updatedAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSubject(
  scopes: PrivateConnectRuntimeAuthorization["scopes"],
  projectIds: string[] = ["proj-allowed"],
  grants?: PrivateConnectRuntimeGrant[],
): PrivateConnectRuntimeAuthorization {
  return {
    deviceId: DEVICE_ID,
    sessionId: SESSION_ID,
    scopes,
    projectIds,
    grants: grants ?? privateConnectRuntimeGrantsFromProjectIds(projectIds),
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

function makeContext(
  conversations: Conversation[] = [makeConversation()],
  overrides: Partial<PrivateConnectScheduledTaskGatewayContext> = {},
): PrivateConnectScheduledTaskGatewayContext {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  return {
    conversation: (conversationId) => byId.get(conversationId) ?? null,
    isConversationAuthorized: (subject, conversation) => (
      conversation.archivedAt === null
      && subject.projectIds.includes(conversation.projectId)
      && privateConnectRuntimeGrantAllowsConversation(
        subject.grants,
        conversation.projectId,
        conversation.id,
      )
    ),
    promptSafetyRejection: (requestId, conversation) => {
      if (conversation.accessMode !== "supervised") {
        return {
          type: "response",
          requestId,
          ok: false,
          code: "forbidden",
          message: "PrivateConnect prompting requires Supervised access on the desktop.",
        };
      }
      const safety = privateConnectPromptSafetyForHarness(conversation.modelSelection.harnessId);
      if (!privateConnectPromptSafetyIsUsable(safety)) {
        return {
          type: "response",
          requestId,
          ok: false,
          code: "forbidden",
          message: safety.explanation,
        };
      }
      return null;
    },
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
    return { task: updated, conversationId: found.boundConversationId ?? CONVERSATION_ID };
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
      boundConversationId: OTHER_CONVERSATION_ID,
    });
    const { handlers } = makeHandlers([allowedTask, foreignTask]);
    // Even if handlers.list returns all tasks unfiltered, the gateway filters strictly.
    handlers.list = vi.fn(() => [allowedTask, foreignTask]);
    const context = makeContext([
      makeConversation({ id: CONVERSATION_ID, projectId: "proj-allowed" }),
      makeConversation({ id: OTHER_CONVERSATION_ID, projectId: "proj-secret" }),
    ]);

    const response = await handlePrivateConnectScheduledTaskRequest(
      makeSubject(["view"], ["proj-allowed"]),
      { type: "scheduled-tasks.list", requestId: REQUEST_ID },
      handlers,
      context,
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
      makeContext(),
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
      makeContext(),
    );

    const parsed = privateConnectRuntimeResponseSchema.parse(response);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.result.kind !== "scheduled-tasks") return;
    expect(parsed.result.tasks).toHaveLength(200);
  });

  it("rejects toggle, run-now, and delete for Monitor devices with forbidden", async () => {
    const { handlers, spies } = makeHandlers([makeTask()]);
    const monitor = makeSubject(["view"], ["proj-allowed"]);
    const context = makeContext();

    const toggleRes = await handlePrivateConnectScheduledTaskRequest(
      monitor,
      { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID, enabled: false },
      handlers,
      context,
    );
    const runRes = await handlePrivateConnectScheduledTaskRequest(
      monitor,
      { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
      handlers,
      context,
    );
    const deleteRes = await handlePrivateConnectScheduledTaskRequest(
      monitor,
      { type: "scheduled-task.delete", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
      handlers,
      context,
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
    const context = makeContext();

    const toggleRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        collaborator,
        { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID, enabled: false },
        handlers,
        context,
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
        context,
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
        context,
      ),
    );
    expect(deleteRes.ok).toBe(true);
    if (deleteRes.ok && deleteRes.result.kind === "scheduled-task.deleted") {
      expect(deleteRes.result.taskId).toBe(TASK_ALLOWED_ID);
    }
    expect(spies.remove).toHaveBeenCalledWith(TASK_ALLOWED_ID);
  });

  it("returns not-found without leaking existence for tasks in ungranted projects", async () => {
    const foreignTask = makeTask({
      id: TASK_FOREIGN_ID,
      projectId: "proj-secret",
      boundConversationId: OTHER_CONVERSATION_ID,
    });
    const { handlers, spies } = makeHandlers([foreignTask]);
    const collaborator = makeSubject(["view", "prompt"], ["proj-allowed"]);
    const context = makeContext([
      makeConversation({ id: OTHER_CONVERSATION_ID, projectId: "proj-secret" }),
    ]);

    const toggleRes = await handlePrivateConnectScheduledTaskRequest(
      collaborator,
      { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: TASK_FOREIGN_ID, enabled: false },
      handlers,
      context,
    );
    const runRes = await handlePrivateConnectScheduledTaskRequest(
      collaborator,
      { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: TASK_FOREIGN_ID },
      handlers,
      context,
    );
    const deleteRes = await handlePrivateConnectScheduledTaskRequest(
      collaborator,
      { type: "scheduled-task.delete", requestId: REQUEST_ID, taskId: TASK_FOREIGN_ID },
      handlers,
      context,
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

  it("hides schedules bound to other conversations, archived conversations, and unbound schedules for single-conversation Monitor grants", async () => {
    const allowedTask = makeTask({
      id: TASK_ALLOWED_ID,
      title: "Allowed thread schedule",
      boundConversationId: CONVERSATION_ID,
    });
    const otherConvTask = makeTask({
      id: TASK_OTHER_CONV_ID,
      title: "Other thread secret schedule",
      boundConversationId: OTHER_CONVERSATION_ID,
    });
    const unboundTask = makeTask({
      id: TASK_UNBOUND_ID,
      title: "Project-wide unbound schedule",
      boundConversationId: null,
    });
    const archivedTask = makeTask({
      id: TASK_ARCHIVED_ID,
      title: "Archived thread schedule",
      boundConversationId: ARCHIVED_CONVERSATION_ID,
    });

    const { handlers } = makeHandlers([allowedTask, otherConvTask, unboundTask, archivedTask]);
    const context = makeContext([
      makeConversation({ id: CONVERSATION_ID, projectId: "proj-allowed" }),
      makeConversation({ id: OTHER_CONVERSATION_ID, projectId: "proj-allowed" }),
      makeConversation({
        id: ARCHIVED_CONVERSATION_ID,
        projectId: "proj-allowed",
        archivedAt: "2027-01-01T12:00:00.000Z",
      }),
    ]);
    const monitorSingleConversation = makeSubject(["view"], ["proj-allowed"], [
      {
        projectId: "proj-allowed",
        conversationIds: [CONVERSATION_ID, ARCHIVED_CONVERSATION_ID],
        includeFutureConversations: false,
        legacyProjectWide: false,
      },
    ]);

    const response = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        monitorSingleConversation,
        { type: "scheduled-tasks.list", requestId: REQUEST_ID },
        handlers,
        context,
      ),
    );

    expect(response.ok).toBe(true);
    if (!response.ok || response.result.kind !== "scheduled-tasks") return;
    expect(response.result.tasks.map((task) => task.id)).toEqual([TASK_ALLOWED_ID]);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("Other thread secret schedule");
    expect(serialized).not.toContain("Project-wide unbound schedule");
    expect(serialized).not.toContain("Archived thread schedule");
  });

  it("returns not-found when a Collaborate device with a single-conversation grant tries to mutate another conversation's or an unbound schedule", async () => {
    const allowedTask = makeTask({ id: TASK_ALLOWED_ID, boundConversationId: CONVERSATION_ID });
    const otherConvTask = makeTask({ id: TASK_OTHER_CONV_ID, boundConversationId: OTHER_CONVERSATION_ID });
    const unboundTask = makeTask({ id: TASK_UNBOUND_ID, boundConversationId: null });
    const archivedTask = makeTask({ id: TASK_ARCHIVED_ID, boundConversationId: ARCHIVED_CONVERSATION_ID });

    const { handlers, spies } = makeHandlers([allowedTask, otherConvTask, unboundTask, archivedTask]);
    const context = makeContext([
      makeConversation({ id: CONVERSATION_ID, projectId: "proj-allowed" }),
      makeConversation({ id: OTHER_CONVERSATION_ID, projectId: "proj-allowed" }),
      makeConversation({
        id: ARCHIVED_CONVERSATION_ID,
        projectId: "proj-allowed",
        archivedAt: "2027-01-01T12:00:00.000Z",
      }),
    ]);
    const singleConvCollaborator = makeSubject(["view", "prompt"], ["proj-allowed"], [
      {
        projectId: "proj-allowed",
        conversationIds: [CONVERSATION_ID],
        includeFutureConversations: false,
        legacyProjectWide: false,
      },
    ]);

    for (const deniedTaskId of [TASK_OTHER_CONV_ID, TASK_UNBOUND_ID, TASK_ARCHIVED_ID]) {
      const toggleRes = await handlePrivateConnectScheduledTaskRequest(
        singleConvCollaborator,
        { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: deniedTaskId, enabled: false },
        handlers,
        context,
      );
      const runRes = await handlePrivateConnectScheduledTaskRequest(
        singleConvCollaborator,
        { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: deniedTaskId },
        handlers,
        context,
      );
      const deleteRes = await handlePrivateConnectScheduledTaskRequest(
        singleConvCollaborator,
        { type: "scheduled-task.delete", requestId: REQUEST_ID, taskId: deniedTaskId },
        handlers,
        context,
      );
      for (const res of [toggleRes, runRes, deleteRes]) {
        const parsed = privateConnectRuntimeResponseSchema.parse(res);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.code).toBe("not-found");
      }
    }
    expect(spies.toggle).not.toHaveBeenCalled();
    expect(spies.runNow).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();

    // Granted conversation's task still succeeds.
    const allowedRun = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        singleConvCollaborator,
        { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
        handlers,
        context,
      ),
    );
    expect(allowedRun.ok).toBe(true);
    expect(spies.runNow).toHaveBeenCalledWith(TASK_ALLOWED_ID);
  });

  it("refuses run-now and enabling when a bound conversation fails prompt safety, while allowing disable and delete", async () => {
    const fullAccessTask = makeTask({
      id: TASK_ALLOWED_ID,
      boundConversationId: CONVERSATION_ID,
      enabled: false,
    });
    const unsupportedHarnessTask = makeTask({
      id: TASK_OTHER_CONV_ID,
      boundConversationId: OTHER_CONVERSATION_ID,
      enabled: false,
    });
    const { handlers, spies } = makeHandlers([fullAccessTask, unsupportedHarnessTask]);
    const context = makeContext([
      makeConversation({
        id: CONVERSATION_ID,
        projectId: "proj-allowed",
        accessMode: "full",
      }),
      makeConversation({
        id: OTHER_CONVERSATION_ID,
        projectId: "proj-allowed",
        accessMode: "supervised",
        modelSelection: makeModelSelection("codex-cli"),
      }),
    ]);
    const collaborator = makeSubject(["view", "prompt"], ["proj-allowed"]);

    for (const taskId of [TASK_ALLOWED_ID, TASK_OTHER_CONV_ID]) {
      const runRes = privateConnectRuntimeResponseSchema.parse(
        await handlePrivateConnectScheduledTaskRequest(
          collaborator,
          { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId },
          handlers,
          context,
        ),
      );
      expect(runRes.ok).toBe(false);
      if (!runRes.ok) expect(runRes.code).toBe("forbidden");

      const enableRes = privateConnectRuntimeResponseSchema.parse(
        await handlePrivateConnectScheduledTaskRequest(
          collaborator,
          { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId, enabled: true },
          handlers,
          context,
        ),
      );
      expect(enableRes.ok).toBe(false);
      if (!enableRes.ok) expect(enableRes.code).toBe("forbidden");
    }
    expect(spies.runNow).not.toHaveBeenCalled();
    expect(spies.toggle).not.toHaveBeenCalled();

    // Disabling and deleting remain permitted for safety control.
    const disableRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        collaborator,
        { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID, enabled: false },
        handlers,
        context,
      ),
    );
    expect(disableRes.ok).toBe(true);
    expect(spies.toggle).toHaveBeenCalledWith(TASK_ALLOWED_ID, false);

    const deleteRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        collaborator,
        { type: "scheduled-task.delete", requestId: REQUEST_ID, taskId: TASK_OTHER_CONV_ID },
        handlers,
        context,
      ),
    );
    expect(deleteRes.ok).toBe(true);
    expect(spies.remove).toHaveBeenCalledWith(TASK_OTHER_CONV_ID);
  });

  it("enforces future-conversation grants and prompt safety for unbound scheduled tasks", async () => {
    const safeUnbound = makeTask({
      id: TASK_ALLOWED_ID,
      boundConversationId: null,
      accessMode: "supervised",
      modelSelection: makeModelSelection("codex-app-server"),
      enabled: false,
    });
    const fullAccessUnbound = makeTask({
      id: TASK_UNBOUND_ID,
      boundConversationId: null,
      accessMode: "full",
      modelSelection: makeModelSelection("codex-app-server"),
      enabled: false,
    });
    const unsafeHarnessUnbound = makeTask({
      id: TASK_OTHER_CONV_ID,
      boundConversationId: null,
      accessMode: "supervised",
      modelSelection: makeModelSelection("codex-cli"),
      enabled: false,
    });
    const { handlers, spies } = makeHandlers([safeUnbound, fullAccessUnbound, unsafeHarnessUnbound]);
    const context = makeContext([]);
    const futureGrantCollaborator = makeSubject(["view", "prompt"], ["proj-allowed"], [
      {
        projectId: "proj-allowed",
        conversationIds: [],
        includeFutureConversations: true,
        legacyProjectWide: false,
      },
    ]);

    const listRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        futureGrantCollaborator,
        { type: "scheduled-tasks.list", requestId: REQUEST_ID },
        handlers,
        context,
      ),
    );
    expect(listRes.ok).toBe(true);
    if (listRes.ok && listRes.result.kind === "scheduled-tasks") {
      expect(listRes.result.tasks.map((task) => task.id)).toEqual([
        TASK_ALLOWED_ID,
        TASK_UNBOUND_ID,
        TASK_OTHER_CONV_ID,
      ]);
    }

    // Safe unbound task can be enabled and run.
    const enableSafe = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        futureGrantCollaborator,
        { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID, enabled: true },
        handlers,
        context,
      ),
    );
    expect(enableSafe.ok).toBe(true);

    const runSafe = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        futureGrantCollaborator,
        { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
        handlers,
        context,
      ),
    );
    expect(runSafe.ok).toBe(true);

    // Full-access and unsupported-harness unbound tasks are rejected on run-now and enable.
    for (const unsafeId of [TASK_UNBOUND_ID, TASK_OTHER_CONV_ID]) {
      const runUnsafe = privateConnectRuntimeResponseSchema.parse(
        await handlePrivateConnectScheduledTaskRequest(
          futureGrantCollaborator,
          { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: unsafeId },
          handlers,
          context,
        ),
      );
      expect(runUnsafe.ok).toBe(false);
      if (!runUnsafe.ok) expect(runUnsafe.code).toBe("forbidden");

      const enableUnsafe = privateConnectRuntimeResponseSchema.parse(
        await handlePrivateConnectScheduledTaskRequest(
          futureGrantCollaborator,
          { type: "scheduled-task.toggle", requestId: REQUEST_ID, taskId: unsafeId, enabled: true },
          handlers,
          context,
        ),
      );
      expect(enableUnsafe.ok).toBe(false);
      if (!enableUnsafe.ok) expect(enableUnsafe.code).toBe("forbidden");
    }
    expect(spies.runNow).toHaveBeenCalledTimes(1);
    expect(spies.toggle).toHaveBeenCalledTimes(1);
  });

  it("wires conversation grants, hidden watcher visibility, and prompt safety through PrivateConnectRuntimeGateway", async () => {
    const allowedConv = makeConversation({
      id: CONVERSATION_ID,
      projectId: "proj-allowed",
      accessMode: "supervised",
      modelSelection: makeModelSelection("codex-app-server"),
    });
    const fullAccessConv = makeConversation({
      id: OTHER_CONVERSATION_ID,
      projectId: "proj-allowed",
      accessMode: "full",
      modelSelection: makeModelSelection("codex-app-server"),
    });
    const hiddenWatcherConv = makeConversation({
      id: WATCHER_CONVERSATION_ID,
      projectId: "proj-allowed",
      accessMode: "supervised",
      modelSelection: makeModelSelection("codex-app-server"),
    });
    const conversations = new Map<string, Conversation>([
      [allowedConv.id, allowedConv],
      [fullAccessConv.id, fullAccessConv],
      [hiddenWatcherConv.id, hiddenWatcherConv],
    ]);

    const safeBoundTask = makeTask({
      id: TASK_ALLOWED_ID,
      boundConversationId: allowedConv.id,
      enabled: false,
    });
    const fullAccessBoundTask = makeTask({
      id: TASK_OTHER_CONV_ID,
      boundConversationId: fullAccessConv.id,
      enabled: false,
    });
    const hiddenWatcherTask = makeTask({
      id: TASK_ARCHIVED_ID,
      boundConversationId: hiddenWatcherConv.id,
      enabled: false,
    });
    const unsafeUnboundTask = makeTask({
      id: TASK_UNBOUND_ID,
      boundConversationId: null,
      accessMode: "supervised",
      modelSelection: makeModelSelection("codex-cli"),
      enabled: false,
    });
    const { handlers, spies } = makeHandlers([
      safeBoundTask,
      fullAccessBoundTask,
      hiddenWatcherTask,
      unsafeUnboundTask,
    ]);

    const gateway = new PrivateConnectRuntimeGateway({
      shell: () => ({
        projects: [{ id: "proj-allowed", name: "Allowed Repo" }],
        conversations: [],
        runs: [],
      } as unknown as AppSnapshot),
      conversation: (id) => conversations.get(id) ?? null,
      detail: () => null,
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: "unused" }),
      privateConnectPromptSafety: (conversation) => (
        privateConnectPromptSafetyForHarness(conversation.modelSelection.harnessId)
      ),
      watcherParent: (id) => (
        id === hiddenWatcherConv.id
          ? { watchedConversationId: allowedConv.id, privateConnect: "hidden" }
          : null
      ),
      scheduledTasks: handlers,
    });

    // Project-wide grant still hides hidden watcher task and rejects unsafe bound/unbound tasks.
    const projectWideCollaborator = makeSubject(["view", "prompt"], ["proj-allowed"]);
    const listRes = await gateway.request(projectWideCollaborator, {
      type: "scheduled-tasks.list",
      requestId: REQUEST_ID,
    });
    expect(listRes.ok).toBe(true);
    if (listRes.ok && listRes.result.kind === "scheduled-tasks") {
      expect(listRes.result.tasks.map((task) => task.id)).toEqual([
        TASK_ALLOWED_ID,
        TASK_OTHER_CONV_ID,
        TASK_UNBOUND_ID,
      ]);
    }

    // Hidden watcher task returns not-found.
    expect(await gateway.request(projectWideCollaborator, {
      type: "scheduled-task.run-now",
      requestId: REQUEST_ID,
      taskId: TASK_ARCHIVED_ID,
    })).toMatchObject({ ok: false, code: "not-found" });

    // Full-access bound conversation task and unsafe-harness unbound task are forbidden on run-now.
    expect(await gateway.request(projectWideCollaborator, {
      type: "scheduled-task.run-now",
      requestId: REQUEST_ID,
      taskId: TASK_OTHER_CONV_ID,
    })).toMatchObject({ ok: false, code: "forbidden" });

    expect(await gateway.request(projectWideCollaborator, {
      type: "scheduled-task.run-now",
      requestId: REQUEST_ID,
      taskId: TASK_UNBOUND_ID,
    })).toMatchObject({ ok: false, code: "forbidden" });

    // Supervised safe bound task succeeds.
    expect(await gateway.request(projectWideCollaborator, {
      type: "scheduled-task.run-now",
      requestId: REQUEST_ID,
      taskId: TASK_ALLOWED_ID,
    })).toMatchObject({ ok: true });
    expect(spies.runNow).toHaveBeenCalledTimes(1);
    expect(spies.runNow).toHaveBeenCalledWith(TASK_ALLOWED_ID);
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
    const context = makeContext();

    handlers.runNow = vi.fn(async () => {
      throw new RuntimeRequestError("Task is already running in /Users/alice/work", "busy");
    });
    const busyRes = privateConnectRuntimeResponseSchema.parse(
      await handlePrivateConnectScheduledTaskRequest(
        collaborator,
        { type: "scheduled-task.run-now", requestId: REQUEST_ID, taskId: TASK_ALLOWED_ID },
        handlers,
        context,
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
        context,
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
        context,
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
