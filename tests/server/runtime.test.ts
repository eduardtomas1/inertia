import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startRuntime, type RunningRuntime } from "../../src/server";
import type { AppSnapshot, ProviderInfo, ServerEvent } from "../../src/shared/contracts";

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

async function removeTemporaryDirectory(directory: string): Promise<void> {
  const retryDelays = process.platform === "win32" ? [0, 250, 750, 1_500, 3_000] : [0];
  let lastError: unknown;

  for (const retryDelay of retryDelays) {
    if (retryDelay > 0) await delay(retryDelay);
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (typeof code !== "string" || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

describe("local runtime", () => {
  const temporaryDirectories: string[] = [];
  const runtimes: RunningRuntime[] = [];
  const restoreEnvironment: Array<() => void> = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    for (const restore of restoreEnvironment.splice(0).reverse()) restore();
    for (const directory of temporaryDirectories.splice(0)) await removeTemporaryDirectory(directory);
  });

  function temporaryWorkspace(): { root: string; data: string; workspace: string } {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-"));
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    temporaryDirectories.push(root);
    return { root, data, workspace };
  }

  function fakeCodex(root: string, runEvents: readonly object[] = []): { authFile: string } {
    const executableDirectory = join(root, "provider-bin");
    const shellDirectory = join(root, "provider-shell");
    const authFile = join(root, "codex-authenticated");
    mkdirSync(executableDirectory);
    mkdirSync(shellDirectory);

    const codex = join(executableDirectory, "codex");
    writeFileSync(codex, `#!${process.execPath}
const { existsSync, writeFileSync } = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
const authFile = ${JSON.stringify(authFile)};
const runEvents = ${JSON.stringify(runEvents)};
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 1.2.3\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (existsSync(authFile)) {
    process.stdout.write("Logged in using ChatGPT\\n");
    process.exit(0);
  }
  process.stderr.write("Not logged in\\n");
  process.exit(1);
}
if (args[0] === "app-server" && args[1] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
if (args.length === 1 && args[0] === "login") {
  writeFileSync(authFile, "connected");
  process.stdout.write("Sign-in complete\\n");
  process.exit(0);
}
if (args.length === 1 && args[0] === "app-server") {
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  let threadId = "fake-thread";
  const turnId = "fake-turn";
  const itemType = (type) => type === "command_execution" ? "commandExecution" : type === "agent_message" ? "agentMessage" : type;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake" } });
    if (message.method === "initialized") return;
    if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
    if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    if (message.method === "thread/start" || message.method === "thread/resume") {
      threadId = message.params.threadId || threadId;
      return send({ id: message.id, result: { thread: { id: threadId }, model: "fake" } });
    }
    if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
      for (const event of runEvents) {
        if (event.type === "item.started" || event.type === "item.completed") {
          send({
            method: event.type === "item.started" ? "item/started" : "item/completed",
            params: { threadId, turnId, item: { ...event.item, type: itemType(event.item?.type) } },
          });
        } else if (event.type === "turn.completed") {
          send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
        }
      }
      return;
    }
    if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
      return send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [], error: null } } });
    }
  });
  return;
}
process.stderr.write("Unexpected fake Codex invocation\\n");
process.exit(2);
`, { mode: 0o700 });
    chmodSync(codex, 0o700);

    const fakeShell = join(shellDirectory, "zsh");
    writeFileSync(fakeShell, `#!${process.execPath}
process.stdout.write(Object.entries(process.env).map(([key, value]) => key + "=" + value).join("\\0") + "\\0");
`, { mode: 0o700 });
    chmodSync(fakeShell, 0o700);

    const previousPath = process.env.PATH;
    const previousShell = process.env.SHELL;
    process.env.PATH = [executableDirectory, dirname(process.execPath), previousPath ?? ""].filter(Boolean).join(delimiter);
    process.env.SHELL = fakeShell;
    restoreEnvironment.push(() => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
    });

    return { authFile };
  }

  async function providerSnapshot(
    events: EventQueue,
    initial: AppSnapshot,
    providerId: ProviderInfo["id"],
    predicate: (provider: ProviderInfo) => boolean,
  ): Promise<AppSnapshot> {
    const current = initial.providers.find(({ id }) => id === providerId);
    if (current && predicate(current)) return initial;
    return (await events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated" && Boolean(event.snapshot.providers.find((provider) => provider.id === providerId && predicate(provider))),
    )).snapshot;
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

  it.skipIf(process.platform === "win32")("updates a matching provider activity instead of persisting duplicate lifecycle rows", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    const { authFile } = fakeCodex(root, [
      { type: "item.started", item: { type: "command_execution" } },
      { type: "item.completed", item: { type: "command_execution" } },
      { type: "item.completed", item: { type: "agent_message", text: "Activity lifecycle complete." } },
      { type: "turn.completed" },
    ]);
    writeFileSync(authFile, "connected");
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: true });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    const ready = await providerSnapshot(
      client.events,
      welcome.snapshot,
      "codex",
      (provider) => provider.authState === "authenticated" && provider.canRun,
    );
    const conversationId = ready.activeConversationId;
    expect(conversationId).toBeTruthy();

    const updateRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.update",
      requestId: updateRequestId,
      payload: { conversationId, accessMode: "full" },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === updateRequestId,
    );

    const messageRequestId = randomUUID();
    send(client.socket, {
      type: "message.send",
      requestId: messageRequestId,
      payload: { conversationId, content: "Exercise one command activity." },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === messageRequestId,
    );
    const started = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "agent.activity" }> =>
        event.type === "agent.activity" && event.activity.kind === "command" && event.activity.status === "running",
    );
    const completed = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "agent.activity" }> =>
        event.type === "agent.activity" && event.activity.id === started.activity.id && event.activity.status === "completed",
    );
    expect(completed.activity).toMatchObject({ id: started.activity.id, runId: started.activity.runId, title: "Command" });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "agent.completed" }> =>
        event.type === "agent.completed" && event.conversationId === conversationId,
    );

    const persisted = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.activities.some((activity) => activity.id === started.activity.id && activity.status === "completed"),
    );
    expect(persisted.snapshot.activities.filter((activity) => activity.runId === started.activity.runId && activity.kind === "command")).toEqual([
      expect.objectContaining({ id: started.activity.id, status: "completed" }),
    ]);
  });

  it.skipIf(process.platform === "win32")("rejects a known-unready provider before persisting a turn, then refreshes its state", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    const { authFile } = fakeCodex(root);
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: true });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    const signedOut = await providerSnapshot(
      client.events,
      welcome.snapshot,
      "codex",
      (provider) => provider.installState === "installed" && provider.authState === "unauthenticated" && !provider.canRun,
    );
    const initialMessageCount = signedOut.messages.length;
    const initialCheckpointCount = signedOut.checkpoints.length;
    const conversationId = signedOut.activeConversationId;
    expect(conversationId).toBeTruthy();

    const messageRequestId = randomUUID();
    send(client.socket, {
      type: "message.send",
      requestId: messageRequestId,
      payload: { conversationId, content: "This turn must not be stored." },
    });
    const rejected = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === messageRequestId,
    );
    expect(rejected.message).toBe("Sign in required");

    const snapshotRequestId = randomUUID();
    send(client.socket, { type: "app.refresh", requestId: snapshotRequestId });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === snapshotRequestId,
    );
    const unchanged = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated",
    );
    expect(unchanged.snapshot.messages).toHaveLength(initialMessageCount);
    expect(unchanged.snapshot.messages.some(({ content }) => content === "This turn must not be stored.")).toBe(false);
    expect(unchanged.snapshot.checkpoints).toHaveLength(initialCheckpointCount);

    writeFileSync(authFile, "connected");
    const refreshRequestId = randomUUID();
    send(client.socket, { type: "provider.refresh", requestId: refreshRequestId, payload: { providerId: "codex" } });
    const connected = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated" && event.snapshot.providers.some((provider) => provider.id === "codex" && provider.authState === "authenticated" && provider.canRun),
    );
    expect(connected.snapshot.providers.find(({ id }) => id === "codex")).toMatchObject({
      installState: "installed",
      authState: "authenticated",
      canRun: true,
      version: "1.2.3",
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === refreshRequestId,
    );
  });

  it.skipIf(process.platform === "win32")("runs provider authentication in an owned terminal and refreshes state after exit", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    fakeCodex(root);
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: true });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    await providerSnapshot(
      client.events,
      welcome.snapshot,
      "codex",
      (provider) => provider.authState === "unauthenticated" && !provider.canRun,
    );

    const authRequestId = randomUUID();
    send(client.socket, {
      type: "provider.auth.start",
      requestId: authRequestId,
      payload: { providerId: "codex", cols: 80, rows: 24 },
    });
    const created = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "terminal.created" }> =>
        event.type === "terminal.created" && event.requestId === authRequestId,
    );
    const output = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "terminal.output" }> =>
        event.type === "terminal.output" && event.terminalId === created.terminalId,
    );
    expect(output.data).toContain("Sign-in complete");
    const exited = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "terminal.exit" }> =>
        event.type === "terminal.exit" && event.terminalId === created.terminalId,
    );
    expect(exited.exitCode).toBe(0);

    const connected = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated" && event.snapshot.providers.some((provider) => provider.id === "codex" && provider.authState === "authenticated" && provider.canRun),
    );
    expect(connected.snapshot.providers.find(({ id }) => id === "codex")).toMatchObject({
      installState: "installed",
      authState: "authenticated",
      canRun: true,
    });
    expect(existsSync(join(root, "codex-authenticated"))).toBe(true);
  });
});
