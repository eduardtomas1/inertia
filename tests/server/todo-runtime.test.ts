import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { RunningRuntime } from "../../src/server";
import type { AppSnapshot, ServerEvent } from "../../src/shared/contracts";
import type { Todo } from "../../src/shared/todos";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import { connectRuntime } from "../support/runtime-event-queue";
import { startTestRuntime } from "../support/test-runtime";

type Client = Awaited<ReturnType<typeof connectRuntime>>;

const runtimes: RunningRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function start(root: string): Promise<RunningRuntime> {
  const runtime = await startTestRuntime({
    dataDirectory: join(root, "data"),
    defaultWorkspacePath: join(root, "workspace"),
    enableProviders: false,
    runtimeGenerationId: `00000000-0000-4000-8000-00000000000${runtimes.length + 1}:1`,
    systemBootId: "test:00000000-0000-4000-8000-000000000001",
  });
  runtimes.push(runtime);
  return runtime;
}

async function welcome(client: Client): Promise<AppSnapshot> {
  const event = await client.events.next((candidate): candidate is Extract<ServerEvent, { type: "server.welcome" }> =>
    candidate.type === "server.welcome", "the welcome snapshot");
  return event.snapshot;
}

async function request(client: Client, type: string, payload: unknown): Promise<ServerEvent> {
  const requestId = randomUUID();
  client.socket.send(JSON.stringify({ type, requestId, payload }));
  return await client.events.next((event): event is ServerEvent =>
    (event.type === "request.ok" || event.type === "request.error" || event.type === "request.result")
    && event.requestId === requestId, `request ${type}`);
}

async function todosUpdated(client: Client, matches: (todos: Todo[]) => boolean): Promise<Todo[]> {
  const event = await client.events.next((candidate): candidate is Extract<ServerEvent, { type: "todos.updated" }> =>
    candidate.type === "todos.updated" && matches(candidate.todos), "a matching task list");
  return event.todos;
}

function recordFrames(client: Client): string[] {
  const types: string[] = [];
  client.socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as ServerEvent;
    if (frame.type === "runtime.event") {
      expect(parseServerEvent(frame)).toBeTruthy();
      types.push(frame.event.type);
    } else {
      types.push(frame.type);
    }
  });
  return types;
}

describe("task commands through the runtime", () => {
  it("routes task commands, publishes the task list without full snapshots and keeps tasks across a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-todo-runtime-"));
    directories.push(root);
    mkdirSync(join(root, "workspace"));
    const runtime = await start(root);
    const client = await connectRuntime(runtime.websocketUrl);
    expect((await welcome(client)).todos).toEqual([]);
    const frames = recordFrames(client);

    const id = randomUUID();
    expect(await request(client, "todo.create", { id, title: "Ship the board", priority: "urgent", dueDate: "2026-10-13" }))
      .toMatchObject({ type: "request.ok" });
    await todosUpdated(client, (todos) => todos.some((todo) => todo.id === id));

    expect(await request(client, "todo.update", { id, patch: { note: "Before Friday.", dueTime: "15:00", completed: true } }))
      .toMatchObject({ type: "request.ok" });
    const updated = await todosUpdated(client, (todos) => todos[0]?.note === "Before Friday.");
    expect(updated[0]).toMatchObject({ id, title: "Ship the board", priority: "urgent", dueDate: "2026-10-13", dueTime: "15:00" });
    expect(updated[0]?.completedAt).not.toBeNull();
    expect(frames.filter((type) => type === "todos.updated")).toHaveLength(2);
    expect(frames).not.toContain("snapshot.updated");

    expect(await request(client, "todo.update", { id, patch: { dueDate: "2026-02-30" } }))
      .toMatchObject({ type: "request.error", message: "Invalid command." });
    const timeOnly = await request(client, "todo.update", { id, patch: { dueDate: null, dueTime: "09:00" } });
    expect(timeOnly).toMatchObject({ type: "request.error", message: "Add a day before a time." });
    expect(timeOnly).not.toHaveProperty("diagnosticId");
    const missing = await request(client, "todo.start", {
      id: randomUUID(),
      conversation: { projectId: randomUUID() },
    });
    expect(missing).toMatchObject({ type: "request.error", message: "That task no longer exists." });
    expect(missing).not.toHaveProperty("diagnosticId");

    client.socket.close();
    await runtimes.pop()!.close();
    const restarted = await start(root);
    const reconnected = await connectRuntime(restarted.websocketUrl);
    expect((await welcome(reconnected)).todos).toEqual(updated);

    expect(await request(reconnected, "todo.delete", { id })).toMatchObject({ type: "request.ok" });
    await todosUpdated(reconnected, (todos) => todos.length === 0);
    reconnected.socket.close();
  });

  it("reports the open task limit plainly, without a diagnostics incident", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-todo-runtime-"));
    directories.push(root);
    mkdirSync(join(root, "workspace"));
    const runtime = await start(root);
    const client = await connectRuntime(runtime.websocketUrl);
    await welcome(client);
    const raw = new Database(join(root, "data", "inertia.sqlite"));
    try {
      const at = new Date().toISOString();
      const insert = raw.prepare(`
        INSERT INTO todos (id, title, note, created_at, updated_at) VALUES (?, ?, '', ?, ?)
      `);
      raw.transaction(() => {
        for (let index = 0; index < 200; index += 1) insert.run(randomUUID(), `Task ${index}`, at, at);
      })();
    } finally {
      raw.close();
    }
    const capped = await request(client, "todo.create", { id: randomUUID(), title: "One more" });
    expect(capped).toEqual({
      type: "request.error",
      requestId: expect.any(String),
      message: "You have 200 open tasks. Finish or delete some first.",
    });
    client.socket.close();
  });
});
