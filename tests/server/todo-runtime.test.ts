import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunningRuntime } from "../../src/server";
import type { AppSnapshot, ServerEvent } from "../../src/shared/contracts";
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

async function snapshot(client: Client, matches: (snapshot: AppSnapshot) => boolean): Promise<AppSnapshot> {
  const event = await client.events.next((candidate): candidate is Extract<ServerEvent, { type: "snapshot.updated" }> =>
    candidate.type === "snapshot.updated" && matches(candidate.snapshot), "a matching snapshot");
  expect(parseServerEvent(event)).toBeTruthy();
  return event.snapshot;
}

describe("task commands through the runtime", () => {
  it("routes task commands, publishes tasks in snapshots and keeps them across a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-todo-runtime-"));
    directories.push(root);
    mkdirSync(join(root, "workspace"));
    const runtime = await start(root);
    const client = await connectRuntime(runtime.websocketUrl);
    expect((await welcome(client)).todos).toEqual([]);

    const id = randomUUID();
    expect(await request(client, "todo.create", { id, title: "Ship the board", priority: "urgent", dueDate: "2026-10-13" }))
      .toMatchObject({ type: "request.ok" });
    await snapshot(client, (candidate) => candidate.todos?.some((todo) => todo.id === id) === true);

    expect(await request(client, "todo.update", { id, patch: { note: "Before Friday.", completed: true } }))
      .toMatchObject({ type: "request.ok" });
    const updated = await snapshot(client, (candidate) => candidate.todos?.[0]?.note === "Before Friday.");
    expect(updated.todos?.[0]).toMatchObject({ id, title: "Ship the board", priority: "urgent", dueDate: "2026-10-13" });
    expect(updated.todos?.[0]?.completedAt).not.toBeNull();

    expect(await request(client, "todo.update", { id, patch: { dueDate: "2026-02-30" } }))
      .toMatchObject({ type: "request.error", message: "Invalid command." });
    expect(await request(client, "todo.start", {
      id: randomUUID(),
      conversation: { projectId: randomUUID() },
    })).toMatchObject({ type: "request.error", message: "That task no longer exists." });

    client.socket.close();
    await runtimes.pop()!.close();
    const restarted = await start(root);
    const reconnected = await connectRuntime(restarted.websocketUrl);
    expect((await welcome(reconnected)).todos).toEqual(updated.todos);

    expect(await request(reconnected, "todo.delete", { id })).toMatchObject({ type: "request.ok" });
    await snapshot(reconnected, (candidate) => candidate.todos?.length === 0);
    reconnected.socket.close();
  });
});
