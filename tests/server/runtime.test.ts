import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startRuntime, type RunningRuntime } from "../../src/server";
import type { ServerEvent } from "../../src/shared/contracts";

class EventQueue {
  private readonly events: ServerEvent[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      this.events.push(JSON.parse(data.toString()) as ServerEvent);
      for (const listener of this.listeners) listener();
    });
  }

  async next<T extends ServerEvent>(predicate: (event: ServerEvent) => event is T): Promise<T> {
    const take = (): T | undefined => {
      const index = this.events.findIndex(predicate);
      if (index < 0) return undefined;
      return this.events.splice(index, 1)[0] as T;
    };
    const existing = take();
    if (existing) return existing;

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error("Timed out waiting for a server event."));
      }, 3_000);
      const check = (): void => {
        const event = take();
        if (!event) return;
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolve(event);
      };
      this.listeners.add(check);
    });
  }
}

async function connect(url: string): Promise<{ socket: WebSocket; events: EventQueue }> {
  const socket = new WebSocket(url, { origin: "http://localhost:5173" });
  const events = new EventQueue(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, events };
}

function send(socket: WebSocket, command: object): void {
  socket.send(JSON.stringify(command));
}

function waitForRejectedUpgrade(url: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    const timeout = setTimeout(() => reject(new Error("Upgrade was not rejected.")), 3_000);
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.on("error", () => {
      // ws may report the rejected handshake after unexpected-response.
    });
  });
}

describe("local runtime", () => {
  const temporaryDirectories: string[] = [];
  const runtimes: RunningRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  function temporaryWorkspace(): { root: string; data: string; workspace: string } {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-"));
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    temporaryDirectories.push(root);
    return { root, data, workspace };
  }

  it("seeds, mutates, and persists a deterministic app snapshot", async () => {
    const { data, workspace } = temporaryWorkspace();
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false });
    runtimes.push(runtime);
    expect(new URL(runtime.websocketUrl).hostname).toBe("127.0.0.1");
    expect(new URL(runtime.websocketUrl).pathname).toMatch(/^\/runtime\/[A-Za-z0-9_-]{40,}$/);

    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next((event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome");
    expect(welcome.snapshot.projects).toHaveLength(1);
    expect(welcome.snapshot.projects[0]?.name).toBe("Getting Started");
    expect(welcome.snapshot.conversations).toHaveLength(1);
    expect(welcome.snapshot.conversations[0]?.accessMode).toBe("supervised");
    expect(welcome.snapshot.settings.defaultAccessMode).toBe("supervised");
    expect(welcome.snapshot.messages.map((message) => message.content)).toHaveLength(3);

    const settingsRequestId = randomUUID();
    send(client.socket, {
      type: "settings.update",
      requestId: settingsRequestId,
      payload: { theme: "dark", compactSidebar: true, terminalFontSize: 15 },
    });
    const settingsResult = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === settingsRequestId,
    );
    expect(settingsResult.requestId).toBe(settingsRequestId);
    const settingsSnapshot = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated",
    );
    expect(settingsSnapshot.snapshot.settings).toMatchObject({ theme: "dark", compactSidebar: true, terminalFontSize: 15 });

    const projectRequestId = randomUUID();
    send(client.socket, {
      type: "project.create",
      requestId: projectRequestId,
      payload: { name: "Inertia", path: workspace },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === projectRequestId,
    );
    const projectSnapshot = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated",
    );
    const project = projectSnapshot.snapshot.projects.find(({ name }) => name === "Inertia");
    expect(project?.path).toBe(workspace);

    const conversationRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.create",
      requestId: conversationRequestId,
      payload: { projectId: project?.id, title: "Runtime work" },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === conversationRequestId,
    );
    const conversationSnapshot = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated",
    );
    const conversation = conversationSnapshot.snapshot.conversations.find(({ title }) => title === "Runtime work");

    const messageRequestId = randomUUID();
    send(client.socket, {
      type: "message.send",
      requestId: messageRequestId,
      payload: { conversationId: conversation?.id, content: "Keep the runtime calm." },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === messageRequestId,
    );
    const messageSnapshot = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated",
    );
    expect(messageSnapshot.snapshot.messages.some(({ content }) => content === "Keep the runtime calm.")).toBe(true);

    client.socket.close();
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);

    const restarted = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false });
    runtimes.push(restarted);
    const persistedClient = await connect(restarted.websocketUrl);
    const persisted = await persistedClient.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    expect(persisted.snapshot.projects).toHaveLength(2);
    expect(persisted.snapshot.settings.theme).toBe("dark");
    expect(persisted.snapshot.messages.some(({ content }) => content === "Keep the runtime calm.")).toBe(true);
  });

  it("rejects unknown paths and remote web origins", async () => {
    const { data, workspace } = temporaryWorkspace();
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false });
    runtimes.push(runtime);

    const url = new URL(runtime.websocketUrl);
    url.pathname = "/runtime/not-the-token";
    await expect(waitForRejectedUpgrade(url.toString(), "http://localhost:5173")).resolves.toBe(404);
    await expect(waitForRejectedUpgrade(runtime.websocketUrl, "https://evil.example")).resolves.toBe(403);
    await expect(waitForRejectedUpgrade(runtime.websocketUrl, "null")).resolves.toBe(403);
  });

  it("returns a scoped request error for malformed or invalid commands", async () => {
    const { data, workspace } = temporaryWorkspace();
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    await client.events.next((event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome");

    const requestId = randomUUID();
    send(client.socket, { type: "settings.update", requestId, payload: { theme: "ultraviolet" } });
    const invalid = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> => event.type === "request.error",
    );
    expect(invalid).toEqual({ type: "request.error", requestId, message: "Invalid command." });
    expect(invalid.message).not.toContain("stack");

    client.socket.send("not json");
    const malformed = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> => event.type === "request.error",
    );
    expect(malformed.message).toBe("Command must be valid JSON.");
    expect(malformed.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("creates an owned terminal and handles input, resize, and close commands", async () => {
    const { data, workspace } = temporaryWorkspace();
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    const projectId = welcome.snapshot.projects[0]?.id;

    const createRequestId = randomUUID();
    send(client.socket, {
      type: "terminal.create",
      requestId: createRequestId,
      payload: { projectId, cols: 80, rows: 24 },
    });
    const created = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "terminal.created" }> =>
        event.type === "terminal.created" && event.requestId === createRequestId,
    );
    expect(created.terminalId).toMatch(/^[0-9a-f-]{36}$/);

    for (const command of [
      { type: "terminal.input", payload: { terminalId: created.terminalId, data: "" } },
      { type: "terminal.resize", payload: { terminalId: created.terminalId, cols: 100, rows: 30 } },
      { type: "terminal.close", payload: { terminalId: created.terminalId } },
    ]) {
      const requestId = randomUUID();
      send(client.socket, { ...command, requestId });
      await client.events.next(
        (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
          event.type === "request.ok" && event.requestId === requestId,
      );
    }
  });
});
