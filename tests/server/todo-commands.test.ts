import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { publicRuntimeError, RuntimeRequestError, userCorrectableRuntimeError } from "../../src/server/runtime-errors";
import { CommandIncidents } from "../../src/server/runtime/command-incidents";
import type { IncidentObservation } from "../../src/node/application-incidents";
import {
  createRuntimeCommandExecutor,
  defineRuntimeCommandHandler,
  RUNTIME_COMMAND_TYPES,
} from "../../src/server/runtime/commands/command-router";
import { createTodoCommandHandler, type TodoCommandDependencies } from "../../src/server/runtime/commands/todo-commands";
import { ConversationCreationService } from "../../src/server/runtime/conversation-creation-service";
import type { ClientCommand, ProviderInfo, RuntimeMutationEvent, ServerEvent } from "../../src/shared/contracts";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { providerIdForHarness, providerNativeModelSelection } from "../../src/shared/model-routing";
import { MAX_OPEN_TODOS, todoPromptContent } from "../../src/shared/todos";
import { hold, isHeld, release, UPDATE_HOLD_MESSAGE } from "../../src/server/runtime/update-hold";

const roots: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const socket = {} as WebSocket;
const providersOn = {
  enableProviders: true,
  providers: [{ id: "codex", canRun: true }] satisfies Partial<ProviderInfo>[],
};

function fixture(options: {
  start?: boolean;
  enableProviders?: boolean;
  providers?: Partial<ProviderInfo>[];
  beforeCreate?: () => void | Promise<void>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "inertia-todo-commands-"));
  roots.push(root);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Tasks", root);
  const service = new ConversationCreationService({
    store,
    providers: {
      resolveModelRoute: (selection: { harnessId: string }) => ({ providerId: providerIdForHarness(selection.harnessId) }),
    } as never,
    backendProfileController: { validateSelection: (selection: unknown) => selection } as never,
    workspaceRuns: {} as never,
    dataDirectory: root,
    broadcastSnapshot: () => undefined,
    providerInfo: () => (options.providers ?? []) as ProviderInfo[],
  });
  const creation = {
    canonicalSelection: service.canonicalSelection.bind(service),
    create: vi.fn(async (...args: Parameters<ConversationCreationService["create"]>) => {
      await options.beforeCreate?.();
      return await service.create(...args);
    }),
  };
  const order: string[] = [];
  const turns = {
    queue: vi.fn((_request: { conversationId: string; content: string }) => ({ turn: { id: "turn-1" } })),
    start: vi.fn(() => options.start ?? true),
    failBeforeStart: vi.fn(() => true),
    isActive: vi.fn((_conversationId: string) => false),
  };
  const events: ServerEvent[] = [];
  const broadcasts: RuntimeMutationEvent[] = [];
  const incidentSink = vi.fn<(observation: IncidentObservation) => unknown>();
  const incidents = new CommandIncidents(incidentSink, "generation-1", userCorrectableRuntimeError);
  const dependencies = {
    store,
    creation,
    turns,
    backendProfileController: { readiness: vi.fn(async () => null) },
    enableProviders: options.enableProviders ?? false,
    verifyProviderInstallation: vi.fn(async () => { order.push("verify"); }),
    providerInfo: () => (options.providers ?? []) as ProviderInfo[],
    broadcast: vi.fn((event: RuntimeMutationEvent) => {
      order.push(event.type);
      broadcasts.push(event);
    }),
    broadcastSnapshot: vi.fn(() => { order.push("snapshot"); }),
    send: vi.fn((_socket: WebSocket, event: ServerEvent) => {
      const observed = incidents.observe(event);
      order.push(observed.type);
      events.push(observed);
    }),
  } as unknown as TodoCommandDependencies;
  const handler = createTodoCommandHandler(dependencies);
  const execute = createRuntimeCommandExecutor({
    handlers: [
      handler,
      defineRuntimeCommandHandler(
        RUNTIME_COMMAND_TYPES.filter((type) => !handler.commandTypes?.includes(type)),
        async () => "not-handled",
      ),
    ],
    send: dependencies.send,
    broadcastSnapshot: dependencies.broadcastSnapshot,
    publicError: publicRuntimeError,
    onFailure: incidents.noteFailure,
  });
  const run = async (type: ClientCommand["type"], payload: unknown) => {
    const command = clientCommandSchema.parse({ type, requestId: randomUUID(), payload });
    events.length = 0;
    order.length = 0;
    broadcasts.length = 0;
    await incidents.run(command, () => execute(socket, command));
    return { command, events: [...events], order: [...order], broadcasts: [...broadcasts] };
  };
  const startPayload = (id: string, replaces?: string) => ({
    id,
    ...(replaces ? { replaces } : {}),
    conversation: {
      projectId: project.id,
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5", alias: "gpt-5", reasoningEffort: "high" }),
      accessMode: "auto-edit",
    },
  });
  return { root, store, project, creation, turns, dependencies, handler, run, startPayload, incidentSink };
}

describe("todo command handler", () => {
  it("owns exactly the task commands", () => {
    const { handler } = fixture();
    expect([...(handler.commandTypes ?? [])].sort()).toEqual(["todo.clearDone", "todo.create", "todo.delete", "todo.start", "todo.update"]);
  });

  it("publishes the task list instead of a full snapshot after create, update, delete and clear done", async () => {
    const { store, project, dependencies, run } = fixture();
    const id = randomUUID();
    const created = await run("todo.create", { id, title: "Write notes", priority: "high", projectId: project.id });
    expect(created.order).toEqual(["todos.updated", "request.ok"]);
    expect(created.broadcasts).toEqual([{ type: "todos.updated", todos: store.todos.list() }]);
    expect(store.snapshot().todos).toEqual([expect.objectContaining({ id, title: "Write notes", priority: "high", note: "", projectId: project.id })]);

    const updated = await run("todo.update", { id, patch: { note: "Short.", dueDate: "2026-10-22", dueTime: "15:00" } });
    expect(updated.order).toEqual(["todos.updated", "request.ok"]);
    expect(updated.broadcasts).toEqual([{
      type: "todos.updated",
      todos: [expect.objectContaining({ id, note: "Short.", dueDate: "2026-10-22", dueTime: "15:00" })],
    }]);
    expect(updated.events).toEqual([{ type: "request.ok", requestId: updated.command.requestId }]);

    const other = randomUUID();
    const unshown = randomUUID();
    await run("todo.create", { id: other, title: "Keep" });
    await run("todo.create", { id: unshown, title: "Finished after the list was cleared" });
    await run("todo.update", { id, patch: { completed: true } });
    await run("todo.update", { id: unshown, patch: { completed: true } });
    const cleared = await run("todo.clearDone", { ids: [id, other] });
    expect(cleared.order).toEqual(["todos.updated", "request.ok"]);
    expect(cleared.broadcasts).toEqual([{ type: "todos.updated", todos: store.todos.list() }]);
    expect(store.todos.list().map(({ id: todoId }) => todoId).sort()).toEqual([other, unshown].sort());
    expect(store.todos.get(id)).toBeNull();
    await run("todo.delete", { id: unshown });

    const deleted = await run("todo.delete", { id: other });
    expect(deleted.order).toEqual(["todos.updated", "request.ok"]);
    expect(deleted.broadcasts).toEqual([{ type: "todos.updated", todos: [] }]);
    expect(store.snapshot().todos).toEqual([]);
    expect(dependencies.broadcastSnapshot).not.toHaveBeenCalled();

    const missing = await run("todo.delete", { id });
    expect(missing.events).toEqual([{ type: "request.error", requestId: missing.command.requestId, message: "That task no longer exists." }]);
    expect(missing.broadcasts).toEqual([]);
  });

  it("reports task validation errors plainly, without an incident", async () => {
    const { store, run, incidentSink } = fixture();
    for (let index = 0; index < MAX_OPEN_TODOS; index += 1) {
      store.todos.create({ id: randomUUID(), title: `Task ${index}` });
    }
    const capped = await run("todo.create", { id: randomUUID(), title: "One more" });
    expect(capped.events).toEqual([{
      type: "request.error",
      requestId: capped.command.requestId,
      message: "You have 200 open tasks. Finish or delete some first.",
    }]);
    const id = store.todos.list()[0]!.id;
    const timeOnly = await run("todo.update", { id, patch: { dueTime: "15:00" } });
    expect(timeOnly.events).toEqual([{ type: "request.error", requestId: timeOnly.command.requestId, message: "Add a day before a time." }]);
    const project = await run("todo.update", { id, patch: { projectId: randomUUID() } });
    expect(project.events).toEqual([{ type: "request.error", requestId: project.command.requestId, message: "That project no longer exists." }]);
    expect(incidentSink).not.toHaveBeenCalled();
  });

  it("remembers the chat a task was written from without handing the task to it", async () => {
    const { store, project, run, startPayload } = fixture();
    const chat = store.createConversation(project.id, "Release prep", { activate: false });
    const id = randomUUID();

    const created = await run("todo.create", {
      id, title: "Fix the build", note: "From the chat.", sourceConversationId: chat.id, projectId: project.id,
    });

    expect(created.order).toEqual(["todos.updated", "request.ok"]);
    expect(created.broadcasts).toEqual([{ type: "todos.updated", todos: store.todos.list() }]);
    expect(store.todos.get(id)).toMatchObject({
      title: "Fix the build",
      note: "From the chat.",
      sourceConversationId: chat.id,
      conversationId: null,
      linkedAt: null,
      projectId: project.id,
      completedAt: null,
    });

    const started = await run("todo.start", startPayload(id));
    expect(started.events).toEqual([expect.objectContaining({ type: "request.result" })]);
    const handedTo = store.todos.get(id)?.conversationId;
    expect(handedTo).toBeTruthy();
    expect(handedTo).not.toBe(chat.id);
    expect(store.todos.get(id)).toMatchObject({ sourceConversationId: chat.id });

    store.deleteConversation(chat.id);
    expect(store.todos.get(id)).toMatchObject({ sourceConversationId: null, conversationId: handedTo });
  });

  it("refuses a source chat from another project or a source chat that does not exist", async () => {
    const { root, store, project, run } = fixture();
    mkdirSync(join(root, "other"));
    const other = store.createProject("Other", join(root, "other"));
    const foreign = store.createConversation(other.id, "Elsewhere", { activate: false });

    const wrongProject = await run("todo.create", {
      id: randomUUID(), title: "Task", sourceConversationId: foreign.id, projectId: project.id,
    });
    expect(wrongProject.events).toEqual([expect.objectContaining({
      type: "request.error", message: "The chat does not belong to this project.",
    })]);

    const unknown = await run("todo.create", {
      id: randomUUID(), title: "Task", sourceConversationId: randomUUID(), projectId: project.id,
    });
    expect(unknown.events).toEqual([expect.objectContaining({
      type: "request.error", message: "That chat no longer exists.",
    })]);

    expect(() => clientCommandSchema.parse({
      type: "todo.create",
      requestId: randomUUID(),
      payload: { id: randomUUID(), title: "Task", sourceConversationId: foreign.id },
    })).toThrow(/must name the chat's project/u);
    expect(() => clientCommandSchema.parse({
      type: "todo.create",
      requestId: randomUUID(),
      payload: { id: randomUUID(), title: "Task", conversationId: foreign.id, projectId: other.id },
    })).toThrow();
    expect(store.snapshot().todos).toEqual([]);
  });

  it("checks the source chat in the repository too", () => {
    const { root, store, project } = fixture();
    mkdirSync(join(root, "elsewhere"));
    const other = store.createProject("Elsewhere", join(root, "elsewhere"));
    const foreign = store.createConversation(other.id, "Elsewhere", { activate: false });
    expect(() => store.todos.create({
      id: randomUUID(), title: "Task", projectId: project.id, sourceConversationId: foreign.id,
    })).toThrow("The chat does not belong to this project.");
    expect(() => store.todos.create({
      id: randomUUID(), title: "Task", projectId: project.id, sourceConversationId: randomUUID(),
    })).toThrow("That chat no longer exists.");
    const plain = store.todos.create({ id: randomUUID(), title: "Plain" });
    expect(plain).toMatchObject({ sourceConversationId: null, conversationId: null });
  });

  it("starts a chat for the task, links it and dispatches the task as the first turn", async () => {
    const { store, project, creation, turns, dependencies, run, startPayload } = fixture(providersOn);
    const id = randomUUID();
    const title = `${"x".repeat(119)}😀 and more`;
    store.todos.create({ id, title, note: "  Check the Linux lane.  " });
    const activeBefore = store.shellSnapshot().activeConversationId;

    const { command, events, order } = await run("todo.start", startPayload(id));

    expect(creation.create).toHaveBeenCalledOnce();
    expect(creation.create.mock.calls[0]).toEqual([{
      ...startPayload(id).conversation,
      title: "x".repeat(119),
      activate: false,
    }, command.requestId]);
    const conversationId = (events.at(-1) as Extract<ServerEvent, { type: "request.result" }>).result as { conversationId: string };
    const conversation = store.conversation(conversationId.conversationId);
    expect(conversation).toMatchObject({
      projectId: project.id,
      title: "x".repeat(119),
      providerId: "codex",
      accessMode: "auto-edit",
      modelSelection: expect.objectContaining({ modelId: "gpt-5", reasoningEffort: "high" }),
    });
    expect(store.shellSnapshot().activeConversationId).toBe(activeBefore);
    expect(store.todos.get(id)).toMatchObject({ conversationId: conversation.id, completedAt: null, projectId: project.id });
    expect(store.todos.get(id)?.linkedAt).toBeTruthy();
    expect(store.conversationTitleLocked(conversation.id)).toBe(true);
    expect(dependencies.verifyProviderInstallation).toHaveBeenCalledWith("codex");
    expect(turns.queue).toHaveBeenCalledWith({
      conversationId: conversation.id,
      content: todoPromptContent({ title, note: "  Check the Linux lane.  " }),
      activateConversation: false,
      contextRequestId: command.requestId,
      turnCheckpoint: true,
      skills: [],
    });
    expect(turns.start).toHaveBeenCalledWith("turn-1");
    expect(turns.failBeforeStart).not.toHaveBeenCalled();
    expect(order).toEqual(["verify", "snapshot", "request.result"]);
    expect(events).toEqual([{
      type: "request.result",
      requestId: command.requestId,
      result: { kind: "todo.started", conversationId: conversation.id },
    }]);
  });

  it("refuses to start a task while Inertia is updating and starts it once the update ends", async () => {
    const { store, creation, turns, run, startPayload } = fixture(providersOn);
    const id = randomUUID();
    store.todos.create({ id, title: "Check the Linux lane" });
    turns.queue.mockImplementation(() => {
      if (isHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
      return { turn: { id: "turn-1" } };
    });
    const owner = hold();
    try {
      const held = await run("todo.start", startPayload(id));
      expect(held.events).toEqual([expect.objectContaining({ type: "request.error", message: UPDATE_HOLD_MESSAGE })]);
      expect(creation.create).not.toHaveBeenCalled();
      expect(turns.queue).not.toHaveBeenCalled();
      expect(store.todos.get(id)?.conversationId).toBeNull();
      expect(store.snapshot().conversations).toEqual([]);
    } finally {
      release(owner);
    }
    const started = await run("todo.start", startPayload(id));
    expect(started.events).toEqual([expect.objectContaining({ type: "request.result", result: expect.objectContaining({ kind: "todo.started" }) })]);
    expect(store.todos.get(id)?.conversationId).toBeTruthy();
  });

  it("leaves the task unstarted and removes its chat when an update begins while the chat is being created", async () => {
    let owner = 0;
    const { store, turns, run, startPayload } = fixture({ ...providersOn, beforeCreate: () => { owner = hold(); } });
    const id = randomUUID();
    store.todos.create({ id, title: "Check the Linux lane" });
    turns.queue.mockImplementation(() => {
      if (isHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
      return { turn: { id: "turn-1" } };
    });
    try {
      const held = await run("todo.start", startPayload(id));
      expect(held.events).toEqual([expect.objectContaining({ type: "request.error", message: UPDATE_HOLD_MESSAGE })]);
      expect(turns.queue).not.toHaveBeenCalled();
      expect(store.todos.get(id)?.conversationId).toBeNull();
      expect(store.snapshot().conversations).toEqual([]);
    } finally {
      release(owner);
    }
  });

  it("records the task as the chat's first message without starting a provider when providers are off", async () => {
    const { store, turns, dependencies, run, startPayload } = fixture();
    const id = randomUUID();
    store.todos.create({ id, title: "Clean the downloads folder", note: "Only the CleanShot files" });
    const activeBefore = store.shellSnapshot().activeConversationId;

    const { command, events, order } = await run("todo.start", startPayload(id));

    const conversationId = store.todos.get(id)?.conversationId;
    expect(conversationId).toBeTruthy();
    expect(store.conversationDetail(conversationId!)?.messages).toEqual([expect.objectContaining({
      role: "user",
      content: "Clean the downloads folder\n\nOnly the CleanShot files",
    })]);
    expect(store.shellSnapshot().activeConversationId).toBe(activeBefore);
    expect(dependencies.verifyProviderInstallation).not.toHaveBeenCalled();
    expect(turns.queue).not.toHaveBeenCalled();
    expect(turns.start).not.toHaveBeenCalled();
    expect(order).toEqual(["snapshot", "request.result"]);
    expect(events).toEqual([{
      type: "request.result",
      requestId: command.requestId,
      result: { kind: "todo.started", conversationId },
    }]);
  });

  it("rejects starting a missing, done or already linked task without creating a chat", async () => {
    const { store, project, creation, turns, run, startPayload, incidentSink } = fixture();
    const missing = await run("todo.start", startPayload(randomUUID()));
    expect(missing.events).toEqual([{ type: "request.error", requestId: missing.command.requestId, message: "That task no longer exists." }]);

    const done = randomUUID();
    store.todos.create({ id: done, title: "Done" });
    store.todos.update(done, { completed: true });
    const finished = await run("todo.start", startPayload(done));
    expect(finished.events).toEqual([{ type: "request.error", requestId: finished.command.requestId, message: "Reopen the task before handing it off." }]);
    expect(store.todos.get(done)?.completedAt).not.toBeNull();

    const id = randomUUID();
    store.todos.create({ id, title: "Linked" });
    const existing = store.createConversation(project.id, "Existing");
    store.todos.link(id, existing.id);
    const linked = await run("todo.start", startPayload(id));
    expect(linked.events).toEqual([{ type: "request.error", requestId: linked.command.requestId, message: "That task is already handed to an agent." }]);
    const elsewhere = await run("todo.start", startPayload(id, randomUUID()));
    expect(elsewhere.events).toEqual([{
      type: "request.error",
      requestId: elsewhere.command.requestId,
      message: "This task was handed off somewhere else in the meantime.",
    }]);

    expect(incidentSink).not.toHaveBeenCalled();
    expect(creation.create).not.toHaveBeenCalled();
    expect(turns.queue).not.toHaveBeenCalled();
    expect(store.shellSnapshot().conversations.map(({ id: conversationId }) => conversationId)).toEqual([existing.id]);
  });

  it("hands a task off again to a new chat and leaves the replaced chat as it was", async () => {
    const { store, project, creation, turns, run, startPayload } = fixture(providersOn);
    const id = randomUUID();
    store.todos.create({ id, title: "Try again" });
    const first = await run("todo.start", startPayload(id));
    const original = (first.events.at(-1) as Extract<ServerEvent, { type: "request.result" }>).result as { conversationId: string };
    const before = store.todos.get(id)!;
    const originalShell = store.conversationShell(original.conversationId);
    const second = await run("todo.start", startPayload(id, original.conversationId));

    expect(second.order).toEqual(["verify", "snapshot", "request.result"]);
    const replacement = (second.events.at(-1) as Extract<ServerEvent, { type: "request.result" }>).result as { conversationId: string };
    expect(replacement.conversationId).not.toBe(original.conversationId);
    expect(creation.create).toHaveBeenCalledTimes(2);
    expect(turns.queue).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: replacement.conversationId, content: "Try again" }));
    expect(store.todos.get(id)).toMatchObject({ conversationId: replacement.conversationId, projectId: project.id });
    expect(store.todos.get(id)!.linkedAt! >= before.linkedAt!).toBe(true);
    expect(store.conversationShell(original.conversationId)).toEqual(originalShell);
    expect(store.shellSnapshot().conversations.map(({ id: conversationId }) => conversationId).sort())
      .toEqual([original.conversationId, replacement.conversationId].sort());
  });

  it("asks to stop the agent before handing off again from a chat that is still working", async () => {
    const { store, project, creation, turns, run, startPayload, incidentSink } = fixture(providersOn);
    const id = randomUUID();
    store.todos.create({ id, title: "Busy" });
    const busy = store.createConversation(project.id, "Busy chat");
    store.todos.link(id, busy.id);
    turns.isActive.mockImplementation((conversationId) => conversationId === busy.id);

    const active = await run("todo.start", startPayload(id, busy.id));
    expect(active.events).toEqual([{ type: "request.error", requestId: active.command.requestId, message: "Stop the agent first." }]);

    turns.isActive.mockImplementation(() => false);
    store.beginAgentTurn({ id: randomUUID(), runId: randomUUID(), conversationId: busy.id,
      content: "Busy", providerId: "codex", harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server", model: "gpt-5", reasoningEffort: "high",
      interactionMode: "build", accessMode: "auto-edit", configurationRevision: 1,
      association: "authoritative" });
    const recorded = await run("todo.start", startPayload(id, busy.id));
    expect(recorded.events).toEqual([{ type: "request.error", requestId: recorded.command.requestId, message: "Stop the agent first." }]);

    expect(creation.create).not.toHaveBeenCalled();
    expect(incidentSink).not.toHaveBeenCalled();
    expect(store.todos.get(id)?.conversationId).toBe(busy.id);
  });

  it("waits to hand off again while a chat stopped by an app update is set to continue", async () => {
    const { store, project, creation, run, startPayload, incidentSink } = fixture(providersOn);
    const id = randomUUID();
    store.todos.create({ id, title: "Updated" });
    const chat = store.createConversation(project.id, "Updated chat");
    store.todos.link(id, chat.id);
    const turnId = randomUUID();
    store.beginAgentTurn({ id: turnId, runId: randomUUID(), conversationId: chat.id,
      content: "Updated", providerId: "codex", harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server", model: "gpt-5", reasoningEffort: "high",
      interactionMode: "build", accessMode: "auto-edit", configurationRevision: 1,
      association: "authoritative" });
    const at = new Date().toISOString();
    store.updateAgentTurnLifecycle(turnId, { status: "interrupted", terminalReason: "app-update", startedAt: at, completedAt: at });
    const [plan] = store.restartContinuations.createForConversations([
      { conversationId: chat.id, interruptedTurnId: turnId, routeIdentity: "route" },
    ]);
    const message = "This chat continues after the update. Try again once it has.";

    const waiting = await run("todo.start", startPayload(id, chat.id));
    expect(waiting.events).toEqual([{ type: "request.error", requestId: waiting.command.requestId, message }]);
    store.restartContinuations.claim(plan!);
    const dispatching = await run("todo.start", startPayload(id, chat.id));
    expect(dispatching.events).toEqual([{ type: "request.error", requestId: dispatching.command.requestId, message }]);
    expect(creation.create).not.toHaveBeenCalled();
    expect(store.todos.get(id)?.conversationId).toBe(chat.id);

    store.restartContinuations.cancel(plan!, "The chat moved on before it could continue.");
    const cancelled = await run("todo.start", startPayload(id, chat.id));
    expect(cancelled.events.at(-1)).toMatchObject({ type: "request.result", result: { kind: "todo.started" } });
    expect(incidentSink).not.toHaveBeenCalled();
  });

  it("removes the new chat when the replaced chat starts working while the new one is created", async () => {
    let busyId = "";
    let turnsRef!: { isActive: ReturnType<typeof vi.fn> };
    const context = fixture({ ...providersOn, beforeCreate: () => { turnsRef.isActive.mockImplementation((conversationId: string) => conversationId === busyId); } });
    turnsRef = context.turns;
    const id = randomUUID();
    context.store.todos.create({ id, title: "Raced" });
    const busy = context.store.createConversation(context.project.id, "Old chat");
    busyId = busy.id;
    context.store.todos.link(id, busy.id);

    const { events } = await context.run("todo.start", context.startPayload(id, busy.id));

    expect(events).toEqual([expect.objectContaining({ type: "request.error", message: "Stop the agent first." })]);
    expect(context.creation.create).toHaveBeenCalledOnce();
    expect(context.store.shellSnapshot().conversations.map(({ id: conversationId }) => conversationId)).toEqual([busy.id]);
    expect(context.store.todos.get(id)?.conversationId).toBe(busy.id);
    expect(context.turns.queue).not.toHaveBeenCalled();
  });

  it("fails the first turn and keeps the linked chat when the turn cannot start", async () => {
    const { store, turns, dependencies, run, startPayload } = fixture({ ...providersOn, start: false });
    const id = randomUUID();
    store.todos.create({ id, title: "Start fails" });

    const { events, order } = await run("todo.start", startPayload(id));

    const conversationId = store.todos.get(id)?.conversationId;
    expect(conversationId).toBeTruthy();
    expect(turns.failBeforeStart).toHaveBeenCalledWith(conversationId, "The task's chat could not start.");
    expect(order).toEqual(["verify", "snapshot", "request.error"]);
    expect(events).toEqual([expect.objectContaining({
      type: "request.error",
      message: "The chat was created, but its first turn could not start.",
    })]);
    expect(dependencies.broadcastSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps the task's prompt in the linked chat when the first turn cannot be queued", async () => {
    const { store, turns, run, startPayload } = fixture(providersOn);
    const id = randomUUID();
    store.todos.create({ id, title: "Queue fails", note: "Runtime is closing" });
    turns.queue.mockImplementation(() => { throw new RuntimeRequestError("The local runtime is shutting down."); });

    const { events, order } = await run("todo.start", startPayload(id));

    const conversationId = store.todos.get(id)?.conversationId;
    expect(conversationId).toBeTruthy();
    expect(store.conversationDetail(conversationId!)?.messages).toEqual([expect.objectContaining({
      role: "user", content: "Queue fails\n\nRuntime is closing", turnId: null,
    })]);
    expect(turns.start).not.toHaveBeenCalled();
    expect(order).toEqual(["verify", "snapshot", "request.error"]);
    expect(events).toEqual([expect.objectContaining({
      type: "request.error",
      message: "The chat was created, but its first turn could not start.",
    })]);
  });

  it("does not repeat the prompt when the first turn was recorded before queueing failed", async () => {
    const { store, turns, run, startPayload } = fixture(providersOn);
    const id = randomUUID();
    store.todos.create({ id, title: "Adoption fails" });
    turns.queue.mockImplementation((request: { conversationId: string; content: string }) => {
      store.beginAgentTurn({ id: randomUUID(), runId: randomUUID(), conversationId: request.conversationId,
        content: request.content, providerId: "codex", harnessId: "codex-app-server",
        backendProfileId: "native:codex:app-server", model: "gpt-5", reasoningEffort: "high",
        interactionMode: "build", accessMode: "auto-edit", configurationRevision: 1,
        association: "authoritative" });
      throw new Error("Adoption failed.");
    });

    const { events } = await run("todo.start", startPayload(id));

    const conversationId = store.todos.get(id)?.conversationId;
    expect(store.conversationDetail(conversationId!)?.messages.map(({ content }) => content)).toEqual(["Adoption fails"]);
    expect(events).toEqual([expect.objectContaining({
      type: "request.error",
      message: "The chat was created, but its first turn could not start.",
    })]);
  });

  it("removes the new empty chat and reports the failure when the task disappears before it is linked", async () => {
    let store!: RuntimeStore;
    let id = "";
    const context = fixture({ ...providersOn, beforeCreate: () => { store.todos.delete(id); } });
    store = context.store;
    id = randomUUID();
    store.todos.create({ id, title: "Deleted mid-start" });

    const { events, order } = await context.run("todo.start", context.startPayload(id));

    expect(events).toEqual([expect.objectContaining({
      type: "request.error",
      message: "That task no longer exists.",
    })]);
    expect(order).toEqual(["verify", "snapshot", "request.error"]);
    expect(context.creation.create).toHaveBeenCalledOnce();
    expect(store.shellSnapshot().conversations).toEqual([]);
    expect(context.turns.queue).not.toHaveBeenCalled();
  });

  it("keeps a new chat that owns its worktree when the task disappears before it is linked", async () => {
    let store!: RuntimeStore;
    let id = "";
    const context = fixture({ ...providersOn, beforeCreate: () => { store.todos.delete(id); } });
    store = context.store;
    id = randomUUID();
    store.todos.create({ id, title: "Deleted mid-start" });
    vi.spyOn(store.conversationWorktrees, "get").mockReturnValue({ ownsWorktree: true } as never);

    const { events } = await context.run("todo.start", context.startPayload(id));

    expect(events).toEqual([expect.objectContaining({
      type: "request.error",
      message: "The chat was created, but the task could not be linked to it.",
    })]);
    expect(store.shellSnapshot().conversations.map(({ title }) => title)).toEqual(["Deleted mid-start"]);
  });

  it("removes the new empty chat and reports a clear message when linking fails outside the task store", async () => {
    const context = fixture(providersOn);
    const id = randomUUID();
    context.store.todos.create({ id, title: "Link fails" });
    vi.spyOn(context.store.todos, "link").mockImplementation(() => { throw new Error("SQLITE_BUSY: database is locked"); });

    const { events, order } = await context.run("todo.start", context.startPayload(id));

    expect(events).toEqual([expect.objectContaining({
      type: "request.error",
      message: "The task could not be handed to an agent.",
    })]);
    expect(order).toEqual(["verify", "snapshot", "request.error"]);
    expect(context.store.shellSnapshot().conversations).toEqual([]);
    expect(context.turns.queue).not.toHaveBeenCalled();
  });

  it("reports the kept chat when the empty chat cannot be removed after linking fails", async () => {
    let store!: RuntimeStore;
    let id = "";
    const context = fixture({ ...providersOn, beforeCreate: () => { store.todos.delete(id); } });
    store = context.store;
    id = randomUUID();
    store.todos.create({ id, title: "Delete fails" });
    vi.spyOn(store, "deleteConversation").mockImplementation(() => { throw new Error("SQLITE_BUSY: database is locked"); });

    const { events, order } = await context.run("todo.start", context.startPayload(id));

    expect(events).toEqual([expect.objectContaining({
      type: "request.error",
      message: "The chat was created, but the task could not be linked to it.",
    })]);
    expect(order).toEqual(["verify", "snapshot", "request.error"]);
    expect(store.shellSnapshot().conversations.map(({ title }) => title)).toEqual(["Delete fails"]);
    expect(context.turns.queue).not.toHaveBeenCalled();
  });

  it("refuses a second start of the same task while the first is still creating its chat", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const context = fixture({ beforeCreate: () => gate });
    const id = randomUUID();
    context.store.todos.create({ id, title: "Double click" });

    const first = context.run("todo.start", context.startPayload(id));
    await vi.waitFor(() => expect(context.creation.create).toHaveBeenCalledOnce());
    const second = await context.run("todo.start", context.startPayload(id));
    expect(second.events).toEqual([expect.objectContaining({ type: "request.error", message: "That task is already starting." })]);
    release();
    await first;

    expect(context.creation.create).toHaveBeenCalledOnce();
    expect(context.store.shellSnapshot().conversations).toHaveLength(1);
    expect(context.store.todos.get(id)?.conversationId).toBe(context.store.shellSnapshot().conversations[0]?.id);
  });

  it("refuses to create a chat when the selected agent is not ready", async () => {
    const context = fixture({
      enableProviders: true,
      providers: [{ id: "codex", canRun: false, statusMessage: "Sign in to Codex first." }],
    });
    const id = randomUUID();
    context.store.todos.create({ id, title: "Not ready" });

    const { events } = await context.run("todo.start", context.startPayload(id));

    expect(events).toEqual([expect.objectContaining({ type: "request.error", message: "Sign in to Codex first." })]);
    expect(events[0]).toHaveProperty("diagnosticId", expect.any(String));
    expect(context.creation.create).not.toHaveBeenCalled();
    expect(context.store.todos.get(id)?.conversationId).toBeNull();
  });
});
