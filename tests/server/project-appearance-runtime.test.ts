import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import type { RunningRuntime } from "../../src/server";
import type { AppSnapshot, ServerEvent } from "../../src/shared/contracts";
import { startTestRuntime as startRuntime } from "../support/test-runtime";

class EventQueue {
  private readonly events: ServerEvent[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      this.events.push(JSON.parse(data.toString()) as ServerEvent);
      for (const waiter of this.waiters) waiter();
    });
  }

  next<T extends ServerEvent>(predicate: (event: ServerEvent) => event is T): Promise<T> {
    const take = (): T | undefined => {
      const index = this.events.findIndex(predicate);
      return index < 0 ? undefined : this.events.splice(index, 1)[0] as T;
    };
    const existing = take();
    if (existing) return Promise.resolve(existing);
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out; pending: ${this.events.map(({ type }) => type).join(", ") || "none"}.`));
      }, 4_000);
      const check = (): void => {
        const event = take();
        if (!event) return;
        clearTimeout(timeout);
        this.waiters.delete(check);
        resolve(event);
      };
      this.waiters.add(check);
    });
  }

  async welcome(): Promise<AppSnapshot> {
    const welcome = await this.next((event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome");
    return welcome.snapshot;
  }

  snapshot(matches: (snapshot: AppSnapshot) => boolean): Promise<AppSnapshot> {
    return this.next((event): event is Extract<ServerEvent, { type: "runtime.event" }> => event.type === "runtime.event"
      && event.event.type === "snapshot.updated" && matches(event.event.snapshot))
      .then((event) => (event.event as Extract<ServerEvent, { type: "snapshot.updated" }>).snapshot);
  }

  async request(command: object): Promise<ServerEvent> {
    const requestId = randomUUID();
    this.socket.send(JSON.stringify({ ...command, requestId }));
    return this.next((event): event is ServerEvent => (event.type === "request.ok" || event.type === "request.error" || event.type === "request.result")
      && "requestId" in event && event.requestId === requestId);
  }
}

async function connect(url: string): Promise<EventQueue> {
  const socket = new WebSocket(url, { origin: "http://localhost:5173" });
  const queue = new EventQueue(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return queue;
}

describe("project appearance commands", () => {
  const runtimes: RunningRuntime[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  async function start(root: string): Promise<RunningRuntime> {
    const runtime = await startRuntime({
      dataDirectory: join(root, "data"),
      defaultWorkspacePath: join(root, "workspace"),
      enableProviders: false,
      runtimeGenerationId: `00000000-0000-4000-8000-00000000000${runtimes.length + 1}:1`,
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
    });
    runtimes.push(runtime);
    return runtime;
  }

  it("merges appearance patches server-side, syncs every window and survives a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-project-appearance-"));
    directories.push(root);
    mkdirSync(join(root, "workspace"));
    const runtime = await start(root);
    const main = await connect(runtime.websocketUrl);
    const detached = await connect(runtime.websocketUrl);
    await Promise.all([main.welcome(), detached.welcome()]);
    expect(await main.request({ type: "project.create", payload: { name: "Studio", path: join(root, "workspace") } }))
      .toMatchObject({ type: "request.result" });
    const project = (await detached.snapshot((candidate) => candidate.projects.length === 1)).projects[0]!;
    const action = { id: randomUUID(), name: "Check", executable: "node", args: ["--version"] };

    expect(await main.request({ type: "project.update", payload: { projectId: project.id,
      preferences: { ...project.preferences!, actions: [action] } } })).toMatchObject({ type: "request.ok" });
    expect(await detached.request({ type: "project.update", payload: { projectId: project.id,
      appearance: { color: { kind: "palette", name: "teal" }, colorEmphasis: "icon-and-name" } } })).toMatchObject({ type: "request.ok" });
    const tinted = (candidate: AppSnapshot): boolean => candidate.projects.some(({ id, preferences }) => (
      id === project.id && preferences?.color?.kind === "palette" && preferences.colorEmphasis === "icon-and-name"));
    for (const client of [main, detached]) {
      expect((await client.snapshot(tinted)).projects.find(({ id }) => id === project.id)?.preferences)
        .toMatchObject({ actions: [action], color: { kind: "palette", name: "teal" }, colorEmphasis: "icon-and-name", pinned: false });
    }

    expect(await main.request({ type: "project.update", payload: { projectId: project.id,
      appearance: { color: { kind: "custom", value: "not-a-colour" } } } })).toMatchObject({ type: "request.error" });
    expect(await main.request({ type: "project.update", payload: { projectId: project.id, appearance: {} } }))
      .toMatchObject({ type: "request.error" });
    expect(await main.request({ type: "project.update", payload: { projectId: project.id,
      appearance: { color: { kind: "custom", value: "#3A86FF" }, pinned: true } } })).toMatchObject({ type: "request.ok" });
    await detached.snapshot((candidate) => candidate.projects.some(({ id, preferences }) => id === project.id && preferences?.pinned === true));

    await runtimes.pop()!.close();
    const restarted = await start(root);
    const reopened = (await (await connect(restarted.websocketUrl)).welcome()).projects.find(({ id }) => id === project.id);
    expect(reopened?.preferences).toMatchObject({ actions: [action], color: { kind: "custom", value: "#3a86ff" },
      colorEmphasis: "icon-and-name", pinned: true });
  });
});
