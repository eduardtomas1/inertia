import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { publicRuntimeError, RuntimeRequestError } from "../../src/server/runtime-errors";
import {
  createRuntimeCommandExecutor,
  defineRuntimeCommandHandler,
  RUNTIME_COMMAND_TYPES,
} from "../../src/server/runtime/commands/command-router";
import { createTodoCommandHandler, type TodoCommandDependencies } from "../../src/server/runtime/commands/todo-commands";
import { ConversationCreationService } from "../../src/server/runtime/conversation-creation-service";
import type { ClientCommand, ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { providerIdForHarness, providerNativeModelSelection } from "../../src/shared/model-routing";
import { todoPromptContent } from "../../src/shared/todos";

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
  };
  const events: ServerEvent[] = [];
  const dependencies = {
    store,
    creation,
    turns,
    backendProfileController: { readiness: vi.fn(async () => null) },
    enableProviders: options.enableProviders ?? false,
    verifyProviderInstallation: vi.fn(async () => { order.push("verify"); }),
    providerInfo: () => (options.providers ?? []) as ProviderInfo[],
    broadcastSnapshot: vi.fn(() => { order.push("snapshot"); }),
    send: vi.fn((_socket: WebSocket, event: ServerEvent) => {
      order.push(event.type);
      events.push(event);
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
  });
  const run = async (type: ClientCommand["type"], payload: unknown) => {
    const command = clientCommandSchema.parse({ type, requestId: randomUUID(), payload });
    events.length = 0;
    order.length = 0;
    await execute(socket, command);
    return { command, events: [...events], order: [...order] };
  };
  const startPayload = (id: string) => ({
    id,
    conversation: {
      projectId: project.id,
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5", alias: "gpt-5", reasoningEffort: "high" }),
      accessMode: "auto-edit",
    },
  });
  return { store, project, creation, turns, dependencies, handler, run, startPayload };
}

describe("todo command handler", () => {
  it("owns exactly the task commands", () => {
    const { handler } = fixture();
    expect([...(handler.commandTypes ?? [])].sort()).toEqual(["todo.create", "todo.delete", "todo.start", "todo.update"]);
  });

  it("creates, updates and deletes tasks as snapshot mutations", async () => {
    const { store, run } = fixture();
    const id = randomUUID();
    const created = await run("todo.create", { id, title: "Write notes", priority: "high" });
    expect(created.order).toEqual(["snapshot", "request.ok"]);
    expect(store.snapshot().todos).toEqual([expect.objectContaining({ id, title: "Write notes", priority: "high", note: "" })]);

    const updated = await run("todo.update", { id, patch: { note: "Short.", completed: true } });
    expect(updated.order).toEqual(["snapshot", "request.ok"]);
    expect(store.todos.get(id)).toMatchObject({ note: "Short." });
    expect(store.todos.get(id)?.completedAt).not.toBeNull();

    const deleted = await run("todo.delete", { id });
    expect(deleted.order).toEqual(["snapshot", "request.ok"]);
    expect(store.snapshot().todos).toEqual([]);

    const missing = await run("todo.delete", { id });
    expect(missing.events).toEqual([expect.objectContaining({ type: "request.error", message: "That task no longer exists." })]);
  });

  it("starts a chat for the task, links it and dispatches the task as the first turn", async () => {
    const { store, project, creation, turns, dependencies, run, startPayload } = fixture(providersOn);
    const id = randomUUID();
    const title = `${"x".repeat(119)}😀 and more`;
    store.todos.create({ id, title, note: "  Check the Linux lane.  " });
    store.todos.update(id, { completed: true });
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
    expect(store.todos.get(id)).toMatchObject({ conversationId: conversation.id, completedAt: null });
    expect(store.conversationTitleLocks.has(conversation.id)).toBe(true);
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

  it("rejects starting a missing or already linked task without creating a chat", async () => {
    const { store, project, creation, turns, run, startPayload } = fixture();
    const missing = await run("todo.start", startPayload(randomUUID()));
    expect(missing.events).toEqual([expect.objectContaining({ type: "request.error", message: "That task no longer exists." })]);

    const id = randomUUID();
    store.todos.create({ id, title: "Linked" });
    const existing = store.createConversation(project.id, "Existing");
    store.todos.link(id, existing.id);
    const linked = await run("todo.start", startPayload(id));
    expect(linked.events).toEqual([expect.objectContaining({ type: "request.error", message: "That task is already handed to an agent." })]);

    expect(creation.create).not.toHaveBeenCalled();
    expect(turns.queue).not.toHaveBeenCalled();
    expect(store.shellSnapshot().conversations.map(({ id: conversationId }) => conversationId)).toEqual([existing.id]);
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
      message: "The chat was created, but the task could not be linked to it.",
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
    expect(context.creation.create).not.toHaveBeenCalled();
    expect(context.store.todos.get(id)?.conversationId).toBeNull();
  });
});
