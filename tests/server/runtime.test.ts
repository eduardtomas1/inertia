import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startRuntime, type RunningRuntime } from "../../src/server";
import type { AppSnapshot, ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import { diffFileFingerprint, parseUnifiedDiff } from "../../src/shared/diff-review";
import { getUnifiedDiff } from "../../src/server/git";
import { portableNodeExecutable, writeNodeSubcommand } from "../helpers/portable-provider-fixture";

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
        const pending = this.events.slice(-12).map((event) => event.type === "request.error" ? `${event.type}:${event.message}` : event.type).join(", ") || "none";
        const latestSnapshot = [...this.events].reverse().find((event) => event.type === "snapshot.updated");
        const providers = latestSnapshot?.type === "snapshot.updated"
          ? latestSnapshot.snapshot.providers.map(({ id, installState, authState, canRun }) => ({ id, installState, authState, canRun }))
          : [];
        reject(new Error(`Timed out waiting for a server event. Pending event types: ${pending}. Providers: ${JSON.stringify(providers)}.`));
      }, 6_000);
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
  // The portable Windows fixture is a relocated node.exe whose subcommand is
  // intentionally cwd-relative. These isolation tests use a cwd-independent
  // Unix wrapper; Windows provider discovery has dedicated native CI coverage.
  const summaryRuntimeIt = process.platform === "win32" ? it.skip : it;
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
    const commandCwd = join(root, "workspace");
    const authFile = join(root, "codex-authenticated");
    mkdirSync(executableDirectory);

    const executable = process.platform === "win32"
      ? portableNodeExecutable(executableDirectory, "codex")
      : join(executableDirectory, "codex");
    writeNodeSubcommand(commandCwd, "login", `
const { existsSync, writeFileSync } = require("node:fs");
const authFile = ${JSON.stringify(authFile)};
if (process.argv[2] === "status") {
  if (existsSync(authFile)) {
    process.stdout.write("Logged in using ChatGPT\\n");
    process.exit(0);
  }
  process.stderr.write("Not logged in\\n");
  process.exit(1);
}
writeFileSync(authFile, "connected");
process.stdout.write("Sign-in complete\\n");
`);
    writeNodeSubcommand(commandCwd, "app-server", `
const readline = require("node:readline");
const args = process.argv.slice(2);
const runEvents = ${JSON.stringify(runEvents)};
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
if (args.length === 0) {
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
        } else if (event.type === "approval.request") {
          send({
            id: "summary-approval",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId,
              turnId,
              itemId: "summary-command",
              command: "touch should-not-run",
              cwd: process.cwd(),
              reason: "Attempt a write",
            },
          });
        } else if (event.type === "turn.completed") {
          const complete = () => send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
          if (event.delayMs) setTimeout(complete, event.delayMs);
          else complete();
        }
      }
      return;
    }
    if (message.id === "summary-approval") return;
    if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
      return send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [], error: null } } });
    }
  });
  return;
}
process.stderr.write("Unexpected fake Codex invocation\\n");
process.exit(2);
`);
    if (process.platform !== "win32") {
      writeFileSync(executable, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(process.version)} + "\\n");
  process.exit(0);
}
const script = args[0] === "login"
  ? ${JSON.stringify(join(commandCwd, "login"))}
  : args[0] === "app-server"
    ? ${JSON.stringify(join(commandCwd, "app-server"))}
    : null;
if (!script) process.exit(2);
const child = spawnSync(process.execPath, [script, ...args.slice(1)], { stdio: "inherit" });
process.exit(child.status ?? 1);
`);
      chmodSync(executable, 0o755);
    }

    const previousPath = process.env.PATH;
    process.env.PATH = [executableDirectory, previousPath ?? ""].filter(Boolean).join(delimiter);
    restoreEnvironment.push(() => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
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

  function initializeChangedRepository(workspace: string): void {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "runtime@example.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Runtime Test"], { cwd: workspace });
    writeFileSync(join(workspace, ".git", "info", "exclude"), "login\napp-server\n");
    writeFileSync(join(workspace, "review.ts"), "export const enabled = false;\n");
    execFileSync("git", ["add", "review.ts"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
    writeFileSync(join(workspace, "review.ts"), "export const enabled = true;\n");
  }

  function reviewResult(patch: string): string {
    const diff = parseUnifiedDiff(patch);
    return JSON.stringify({
      overall: "Enables the reviewed behavior.",
      classifications: [{ classification: "behavior-change", evidence: "The exported enabled value changes from false to true." }],
      files: diff.files.map((file) => ({
        path: file.path,
        summary: "Changes the exported enabled value.",
        classifications: [{ classification: "test-impact", evidence: "Tests of the exported default may need updating." }],
        hunks: file.hunks.map((hunk) => ({
          hunkId: hunk.id,
          summary: "Flips the enabled constant from false to true.",
          classifications: [],
        })),
      })),
    });
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

  it("controls only the exact managed project action and persists a safe rerun identity", async () => {
    const { data, workspace } = temporaryWorkspace();
    writeFileSync(join(workspace, "package.json"), JSON.stringify({
      name: "activity-control-fixture",
      private: true,
      scripts: {
        preview: "node -e \"console.log('http://localhost:45678'); setInterval(() => {}, 1000)\"",
      },
    }));
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    const projectId = welcome.snapshot.projects[0]!.id;

    const runRequestId = randomUUID();
    send(client.socket, {
      type: "project.action.run",
      requestId: runRequestId,
      payload: { projectId, actionId: "preview", cols: 80, rows: 24 },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "terminal.created" }> =>
        event.type === "terminal.created" && event.requestId === runRequestId,
    );
    const running = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) =>
          run.projectId === projectId
          && run.actionId === "preview"
          && run.kind === "service"
          && run.status === "running"
          && run.canStop
          && run.port === 45678),
    );
    const activity = running.snapshot.runs.find((run) => run.actionId === "preview" && run.status === "running")!;

    const removeProjectRequestId = randomUUID();
    send(client.socket, {
      type: "project.remove",
      requestId: removeProjectRequestId,
      payload: { projectId },
    });
    const removalRejected = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === removeProjectRequestId,
    );
    expect(removalRejected.message).toBe("Stop active work for this project before removing it.");

    const unrelatedStopId = randomUUID();
    send(client.socket, {
      type: "activity.stop",
      requestId: unrelatedStopId,
      payload: { runId: randomUUID() },
    });
    const unrelated = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === unrelatedStopId,
    );
    expect(unrelated.message).toBe("Workspace activity not found.");

    const stopRequestId = randomUUID();
    send(client.socket, {
      type: "activity.stop",
      requestId: stopRequestId,
      payload: { runId: activity.id },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === stopRequestId,
    );
    const stopped = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) => run.id === activity.id && run.status === "cancelled" && !run.canStop),
    );
    expect(stopped.snapshot.runs.find((run) => run.id === activity.id)).toMatchObject({
      actionId: "preview",
      detail: "Stopped",
      finishedAt: expect.any(String),
    });

    const rerunRequestId = randomUUID();
    send(client.socket, {
      type: "project.action.run",
      requestId: rerunRequestId,
      payload: { projectId, actionId: activity.actionId, cols: 80, rows: 24 },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "terminal.created" }> =>
        event.type === "terminal.created" && event.requestId === rerunRequestId,
    );
    const rerunning = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) =>
          run.id !== activity.id
          && run.actionId === activity.actionId
          && run.status === "running"
          && run.canStop),
    );
    const rerun = rerunning.snapshot.runs.find((run) => run.id !== activity.id && run.actionId === activity.actionId)!;
    const stopRerunRequestId = randomUUID();
    send(client.socket, {
      type: "activity.stop",
      requestId: stopRerunRequestId,
      payload: { runId: rerun.id },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === stopRerunRequestId,
    );

    const dismissRequestId = randomUUID();
    send(client.socket, {
      type: "activity.dismiss",
      requestId: dismissRequestId,
      payload: { runId: activity.id },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === dismissRequestId,
    );
    const dismissed = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated" && !event.snapshot.runs.some((run) => run.id === activity.id),
    );
    expect(dismissed.snapshot.runs.some((run) => run.id === activity.id)).toBe(false);
  });

  it("updates a matching provider activity instead of persisting duplicate lifecycle rows", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    const { authFile } = fakeCodex(root, [
      { type: "item.started", item: { type: "command_execution", command: "npm test" } },
      { type: "item.completed", item: { type: "command_execution", command: "npm test" } },
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
    const runningCheck = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) =>
          run.conversationId === conversationId
          && run.kind === "check"
          && run.label === "npm test"
          && run.status === "running"),
    );
    const commandRun = runningCheck.snapshot.runs.find((run) =>
      run.conversationId === conversationId
      && run.kind === "check"
      && run.label === "npm test");
    expect(commandRun).toMatchObject({
      actionId: null,
      canStop: false,
      status: "running",
    });
    const completed = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "agent.activity" }> =>
        event.type === "agent.activity" && event.activity.id === started.activity.id && event.activity.status === "completed",
    );
    expect(completed.activity).toMatchObject({ id: started.activity.id, runId: started.activity.runId, title: "npm test" });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) =>
          run.id === commandRun?.id
          && run.status === "succeeded"
          && run.finishedAt !== null),
    );
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
    expect(persisted.snapshot.runs).toContainEqual(expect.objectContaining({
      id: commandRun?.id,
      kind: "check",
      label: "npm test",
      status: "succeeded",
      canStop: false,
    }));
  });

  it("invalidates reviewed targets and notes immediately after committing their change", async () => {
    const { data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    const projectId = welcome.snapshot.activeProjectId!;
    const conversationId = welcome.snapshot.activeConversationId!;
    const diff = parseUnifiedDiff((await getUnifiedDiff(workspace)).text);
    const file = diff.files[0]!;
    const targetFingerprint = diffFileFingerprint(file);

    const stateRequestId = randomUUID();
    send(client.socket, {
      type: "review.state.set",
      requestId: stateRequestId,
      payload: {
        conversationId,
        scope: "file",
        path: file.path,
        hunkId: null,
        targetFingerprint,
        reviewed: true,
      },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === stateRequestId,
    );
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.reviewStates.some((state) =>
          state.conversationId === conversationId && state.path === file.path && state.reviewed && !state.stale),
    );

    const noteRequestId = randomUUID();
    send(client.socket, {
      type: "review.note.create",
      requestId: noteRequestId,
      payload: {
        conversationId,
        path: file.path,
        hunkId: null,
        lineIds: [],
        targetFingerprint,
        body: "Keep this review checkpoint after the commit.",
      },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === noteRequestId,
    );
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.reviewNotes.some((note) =>
          note.conversationId === conversationId && note.path === file.path && !note.stale),
    );

    const commitRequestId = randomUUID();
    send(client.socket, {
      type: "git.commit",
      requestId: commitRequestId,
      payload: {
        projectId,
        conversationId,
        message: "Commit reviewed change",
        paths: [file.path],
      },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === commitRequestId
        && event.result.kind === "git.action",
    );
    const invalidated = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.reviewStates.some((state) =>
          state.conversationId === conversationId && state.path === file.path && !state.reviewed && state.stale)
        && event.snapshot.reviewNotes.some((note) =>
          note.conversationId === conversationId && note.path === file.path && note.stale),
    );

    expect(invalidated.snapshot.reviewStates).toContainEqual(expect.objectContaining({
      conversationId,
      path: file.path,
      reviewed: false,
      stale: true,
    }));
    expect(invalidated.snapshot.reviewNotes).toContainEqual(expect.objectContaining({
      conversationId,
      path: file.path,
      body: "Keep this review checkpoint after the commit.",
      stale: true,
    }));
  });

  it("rejects a known-unready provider before persisting a turn, then refreshes its state", async () => {
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
      version: process.version,
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === refreshRequestId,
    );
  });

  it("runs provider authentication in an owned terminal and refreshes state after exit", async () => {
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
    let terminalOutput = "";
    let exited: Extract<ServerEvent, { type: "terminal.exit" }> | undefined;
    while (!exited) {
      const terminalEvent = await client.events.next(
        (event): event is Extract<ServerEvent, { type: "terminal.output" | "terminal.exit" }> =>
          (event.type === "terminal.output" || event.type === "terminal.exit") && event.terminalId === created.terminalId,
      );
      if (terminalEvent.type === "terminal.output") terminalOutput += terminalEvent.data;
      else exited = terminalEvent;
    }
    expect(terminalOutput).toContain("Sign-in complete");
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

  summaryRuntimeIt("runs diff summaries in an isolated session, exposes Activity status, and cleans up without contaminating the thread", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    const diff = await getUnifiedDiff(workspace);
    const { authFile } = fakeCodex(root, [
      { type: "item.completed", item: { type: "agent_message", text: reviewResult(diff.text) } },
      { type: "turn.completed" },
    ]);
    writeFileSync(authFile, "connected");
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: true });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    const ready = await providerSnapshot(client.events, welcome.snapshot, "codex", (provider) => provider.canRun);
    const conversationId = ready.activeConversationId!;
    const projectId = ready.activeProjectId!;
    const fingerprint = parseUnifiedDiff(diff.text).fingerprint;
    const requestId = randomUUID();
    send(client.socket, {
      type: "review.summary.generate",
      requestId,
      payload: { projectId, conversationId, fingerprint },
    });

    const running = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) => run.conversationId === conversationId && run.label.includes("read-only diff summary") && run.status === "running"),
    );
    expect(running.snapshot.runs.find((run) => run.conversationId === conversationId && run.label.includes("read-only diff summary")))
      .toMatchObject({ kind: "agent", status: "running", detail: "1 file · isolated session" });

    const result = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result" && event.requestId === requestId && event.result.kind === "review.summary",
    );
    expect(result.result.kind === "review.summary" && result.result.summary).toMatchObject({
      fingerprint,
      providerId: "codex",
      classifications: [{ classification: "behavior-change" }],
    });
    const completed = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) => run.conversationId === conversationId && run.label.includes("read-only diff summary") && run.status === "succeeded"),
    );
    expect(completed.snapshot.conversations.find(({ id }) => id === conversationId)?.providerSessionId).toBeNull();
    expect(completed.snapshot.reviewSummaries).toHaveLength(1);
    expect(readFileSync(join(workspace, "review.ts"), "utf8")).toBe("export const enabled = true;\n");

    for (let attempt = 0; attempt < 20 && readdirSync(data).some((name) => name.startsWith("read-only-summary-")); attempt += 1) {
      await delay(10);
    }
    expect(readdirSync(data).filter((name) => name.startsWith("read-only-summary-"))).toEqual([]);
  });

  summaryRuntimeIt("deduplicates and explicitly cancels an active diff summary with recoverable Activity cleanup", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    const diff = await getUnifiedDiff(workspace);
    const { authFile } = fakeCodex(root);
    writeFileSync(authFile, "connected");
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: true });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    const ready = await providerSnapshot(client.events, welcome.snapshot, "codex", (provider) => provider.canRun);
    const conversationId = ready.activeConversationId!;
    const projectId = ready.activeProjectId!;
    const fingerprint = parseUnifiedDiff(diff.text).fingerprint;
    const summaryRequestId = randomUUID();
    send(client.socket, {
      type: "review.summary.generate",
      requestId: summaryRequestId,
      payload: { projectId, conversationId, fingerprint },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) => run.conversationId === conversationId && run.label.includes("read-only diff summary") && run.status === "running"),
    );

    for (const blocked of [
      {
        type: "conversation.update",
        payload: { conversationId, providerId: "claude" },
        message: "Stop the active run or review before changing its agent configuration.",
      },
      {
        type: "conversation.archive",
        payload: { conversationId },
        message: "Stop the active run or review before archiving this thread.",
      },
      {
        type: "conversation.delete",
        payload: { conversationId },
        message: "Stop the active run or review before deleting this thread.",
      },
      {
        type: "project.remove",
        payload: { projectId },
        message: "Stop active work for this project before removing it.",
      },
    ] as const) {
      const requestId = randomUUID();
      send(client.socket, { type: blocked.type, requestId, payload: blocked.payload });
      const rejected = await client.events.next(
        (event): event is Extract<ServerEvent, { type: "request.error" }> =>
          event.type === "request.error" && event.requestId === requestId,
      );
      expect(rejected.message).toBe(blocked.message);
    }

    const duplicateRequestId = randomUUID();
    send(client.socket, {
      type: "review.summary.generate",
      requestId: duplicateRequestId,
      payload: { projectId, conversationId, fingerprint },
    });
    const duplicate = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === duplicateRequestId,
    );
    expect(duplicate.message).toMatch(/already running/u);

    const cancelRequestId = randomUUID();
    send(client.socket, {
      type: "review.summary.cancel",
      requestId: cancelRequestId,
      payload: { conversationId },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === cancelRequestId,
    );
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === summaryRequestId,
    );
    const settled = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) => run.conversationId === conversationId && run.label.includes("read-only diff summary") && run.status === "cancelled"),
    );
    expect(settled.snapshot.reviewSummaries).toEqual([]);
    for (let attempt = 0; attempt < 20 && readdirSync(data).some((name) => name.startsWith("read-only-summary-")); attempt += 1) {
      await delay(10);
    }
    expect(readdirSync(data).filter((name) => name.startsWith("read-only-summary-"))).toEqual([]);
  });

  summaryRuntimeIt("fails closed when a summary requests interaction or the diff changes concurrently", async () => {
    for (const scenario of ["interaction", "stale"] as const) {
      const { root, data, workspace } = temporaryWorkspace();
      initializeChangedRepository(workspace);
      const diff = await getUnifiedDiff(workspace);
      const runEvents = scenario === "interaction"
        ? [{ type: "approval.request" }]
        : [
            { type: "item.completed", item: { type: "agent_message", text: reviewResult(diff.text) } },
            { type: "turn.completed", delayMs: 150 },
          ];
      const { authFile } = fakeCodex(root, runEvents);
      writeFileSync(authFile, "connected");
      const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: true });
      runtimes.push(runtime);
      const client = await connect(runtime.websocketUrl);
      const welcome = await client.events.next(
        (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
      );
      const ready = await providerSnapshot(client.events, welcome.snapshot, "codex", (provider) => provider.canRun);
      const conversationId = ready.activeConversationId!;
      const projectId = ready.activeProjectId!;
      const requestId = randomUUID();
      send(client.socket, {
        type: "review.summary.generate",
        requestId,
        payload: { projectId, conversationId, fingerprint: parseUnifiedDiff(diff.text).fingerprint },
      });
      await client.events.next(
        (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
          event.type === "snapshot.updated"
          && event.snapshot.runs.some((run) => run.conversationId === conversationId && run.label.includes("read-only diff summary") && run.status === "running"),
      );
      if (scenario === "stale") writeFileSync(join(workspace, "review.ts"), "export const enabled = \"changed concurrently\";\n");
      const failed = await client.events.next(
        (event): event is Extract<ServerEvent, { type: "request.error" }> =>
          event.type === "request.error" && event.requestId === requestId,
      );
      expect(failed.message).toMatch(scenario === "interaction" ? /unsupported interaction/u : /stale summary was discarded/u);
      const settled = await client.events.next(
        (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
          event.type === "snapshot.updated"
          && event.snapshot.runs.some((run) => run.conversationId === conversationId && run.label.includes("read-only diff summary") && run.status === "failed"),
      );
      expect(settled.snapshot.reviewSummaries).toEqual([]);
      expect(existsSync(join(workspace, "should-not-run"))).toBe(false);
      client.socket.close();
      await runtime.close();
      runtimes.splice(runtimes.indexOf(runtime), 1);
    }
  });

  summaryRuntimeIt("times out a non-responsive summary and records the failure without persistence", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    const diff = await getUnifiedDiff(workspace);
    const { authFile } = fakeCodex(root);
    writeFileSync(authFile, "connected");
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      reviewSummaryTimeoutMs: 20,
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    const ready = await providerSnapshot(client.events, welcome.snapshot, "codex", (provider) => provider.canRun);
    const requestId = randomUUID();
    send(client.socket, {
      type: "review.summary.generate",
      requestId,
      payload: {
        projectId: ready.activeProjectId!,
        conversationId: ready.activeConversationId!,
        fingerprint: parseUnifiedDiff(diff.text).fingerprint,
      },
    });
    const failed = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === requestId,
    );
    expect(failed.message).toMatch(/timed out/u);
    const settled = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) => run.label.includes("read-only diff summary") && run.status === "failed"),
    );
    expect(settled.snapshot.reviewSummaries).toEqual([]);
    expect(readdirSync(data).filter((name) => name.startsWith("read-only-summary-"))).toEqual([]);
  });
});
