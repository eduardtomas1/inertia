import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunningRuntime } from "../../src/server";
import type {
  AppSnapshot,
  ConversationDetail,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import {
  diffFileFingerprint,
  diffHunkFingerprint,
  parseUnifiedDiff,
} from "../../src/shared/diff-review";
import { RuntimeStore } from "../../src/server/database";
import { getUnifiedDiff } from "../../src/server/git";
import { portableNodeExecutable, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";
import {
  connectRuntime as connect,
  RuntimeEventQueue as EventQueue,
} from "../support/runtime-event-queue";
import {
  loadConversationDetail,
  loadConversationDetailResult,
} from "../support/runtime-conversation-detail";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";
import { startTestRuntime as startRuntime } from "../support/test-runtime";

const runtimeIdentity = {
  runtimeGenerationId: "00000000-0000-4000-8000-000000000001:1",
  systemBootId: "test:00000000-0000-4000-8000-000000000001",
} as const;

function send(socket: WebSocket, command: object): void { socket.send(JSON.stringify(command)); }
function providerReady(provider: ProviderInfo): boolean {
  const { models, rateLimits } = provider.metadataState;
  return provider.authState === "authenticated" && provider.canRun && models.lastAttemptedAt !== null
    && rateLimits.lastAttemptedAt !== null && !models.refreshing && !rateLimits.refreshing;
}

async function waitForConversationDetail(
  socket: WebSocket,
  events: EventQueue,
  conversationId: string,
  predicate: (detail: ConversationDetail) => boolean,
): Promise<ConversationDetail> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const detail = await loadConversationDetail(socket, events, conversationId);
    if (predicate(detail)) return detail;
    await delay(25);
  }
  throw new Error(`Conversation detail for ${conversationId} did not reach the expected state.`);
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
    vi.restoreAllMocks();
  });

  function temporaryWorkspace(options: { withProject?: boolean } = {}): { root: string; data: string; workspace: string } {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-"));
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    if (options.withProject !== false) {
      mkdirSync(data);
      const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
      const project = store.createProject("Test project", workspace);
      store.createConversation(project.id, "Test chat");
      store.close();
    }
    temporaryDirectories.push(root);
    return { root, data, workspace };
  }

  function fakeCodex(root: string, runEvents: readonly object[] = []): { authFile: string; executable: string } {
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
          const complete = () => send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: event.status || "completed", items: [], error: event.error || null } } });
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

    return { authFile, executable };
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

  it("does not delay readiness while recovered attachment cleanup is stalled", async () => {
    const { data, workspace } = temporaryWorkspace();
    const seed = new RuntimeStore(
      join(data, "inertia.sqlite"),
      workspace,
      { recoverInterruptedRuns: false },
    );
    const conversation = seed.shellSnapshot().conversations[0];
    if (!conversation) throw new Error("Missing seeded conversation.");
    const attachmentId = randomUUID();
    seed.beginAgentTurn({
      id: randomUUID(),
      conversationId: conversation.id,
      runId: randomUUID(),
      content: "Recover without waiting for attachment cleanup.",
      attachments: [{
        id: attachmentId,
        name: "recovery.png",
        path: join(workspace, "recovery.png"),
        mimeType: "image/png",
        size: 8,
      }],
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    seed.close();

    let releaseStarted = false;
    const stalledRelease = new Promise<boolean>(() => undefined);
    const runtime = await Promise.race([
      startRuntime({
        dataDirectory: data,
        defaultWorkspacePath: workspace,
        enableProviders: false,
      ...runtimeIdentity,
        attachments: {
          resolve: async () => null,
          release: () => {
            releaseStarted = true;
            return stalledRelease;
          },
          cleanup: () => {
            releaseStarted = true;
            return stalledRelease;
          },
          relinquish: async () => true,
        },
      }),
      delay(2_000).then(() => {
        throw new Error("Runtime readiness waited for optional attachment cleanup.");
      }),
    ]);
    runtimes.push(runtime);

    expect(releaseStarted).toBe(true);
    expect(new URL(runtime.websocketUrl).hostname).toBe("127.0.0.1");
  }, 30_000);

  it("waits for terminal settlement work before opening a recovery import", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    const recoveryPath = join(root, "recovery.json");
    const targetDirectory = join(root, "recovered");
    mkdirSync(targetDirectory, { mode: 0o700 });
    writeFileSync(recoveryPath, JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: "2026-08-02T08:00:00.000Z",
      projects: [],
    }), { encoding: "utf8", mode: 0o600 });
    const { authFile, executable } = fakeCodex(root, [
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Settlement is authoritative." },
      },
      { type: "turn.completed", delayMs: 500 },
    ]);
    writeFileSync(authFile, "connected");
    let releaseIdentityRefresh!: () => void;
    const identityRefreshGate = new Promise<void>((resolve) => {
      releaseIdentityRefresh = resolve;
    });
    let releaseSettlement!: () => void;
    let settlementStarted = false;
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      ...runtimeIdentity,
      codexBinaryPath: executable,
      testOnlyProjectIdentityRefresh: identityRefreshGate,
      testOnlyOnTurnSettled: (turn) => {
        expect(turn.status).toBe("completed");
        settlementStarted = true;
        return settlementGate;
      },
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const ready = await providerSnapshot(
      client.events,
      welcome.snapshot,
      "codex",
      providerReady,
    );
    const conversationId = ready.activeConversationId!;
    const requestId = randomUUID();
    send(client.socket, {
      type: "message.send",
      requestId,
      payload: { conversationId, content: "Complete before recovery." },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === requestId
        && event.result.kind === "message.accepted",
    );
    const cancellation = new AbortController();
    let importSettled = false;
    const pendingImport = runtime.importRecoveryData(
      recoveryPath,
      targetDirectory,
      cancellation.signal,
      randomUUID(),
    );
    void pendingImport.then(
      () => { importSettled = true; },
      () => { importSettled = true; },
    );
    try {
      await client.events.next(
        (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
          event.type === "snapshot.updated"
          && event.snapshot.conversations.some(
            ({ id, latestTurn }) =>
              id === conversationId && latestTurn?.status === "completed",
          ),
      );
      expect(settlementStarted).toBe(true);
      expect(importSettled).toBe(false);

      // The turn settled while recovery was inside its project-identity await.
      // Releasing that await must still reach the final settlement drain.
      releaseIdentityRefresh();
      await delay(100);
      expect(importSettled).toBe(false);
      expect(readdirSync(targetDirectory)).toEqual([]);

      cancellation.abort(new Error("Cancel while settlement is draining."));
      await expect(pendingImport).rejects.toThrow(
        "Cancel while settlement is draining.",
      );
      expect(readdirSync(targetDirectory)).toEqual([]);
    } finally {
      releaseIdentityRefresh();
      releaseSettlement();
    }
  }, 30_000);

  it.each([
    ["failed", "failed"],
    ["interrupted", "cancelled"],
  ] as const)(
    "restarts backup quiet grace after a %s provider turn",
    async (providerStatus, expectedStatus) => {
      const { root, data, workspace } = temporaryWorkspace();
      const { authFile, executable } = fakeCodex(root, [
        {
          type: "turn.completed",
          status: providerStatus,
          error: providerStatus === "failed"
            ? { message: "Provider failed for the regression fixture." }
            : null,
        },
      ]);
      writeFileSync(authFile, "connected");
      const backupRequest = vi.spyOn(
        RuntimeStore.prototype,
        "createInitialBackup",
      );
      const runtime = await startRuntime({
        dataDirectory: data,
        defaultWorkspacePath: workspace,
        enableProviders: true,
      ...runtimeIdentity,
        codexBinaryPath: executable,
      });
      runtimes.push(runtime);
      const client = await connect(runtime.websocketUrl);
      const welcome = await client.events.next(
        (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
          event.type === "server.welcome",
      );
      const ready = await providerSnapshot(
        client.events,
        welcome.snapshot,
        "codex",
        (provider) => provider.authState === "authenticated" && provider.canRun,
      );
      const conversationId = ready.activeConversationId!;
      const requestId = randomUUID();
      send(client.socket, {
        type: "message.send",
        requestId,
        payload: { conversationId, content: `Settle as ${providerStatus}.` },
      });
      await client.events.next(
        (event): event is Extract<ServerEvent, { type: "request.result" }> =>
          event.type === "request.result"
          && event.requestId === requestId
          && event.result.kind === "message.accepted",
      );
      await client.events.next(
        (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
          event.type === "snapshot.updated"
          && event.snapshot.conversations.some(({ id, latestTurn }) =>
            id === conversationId
            && latestTurn?.status === expectedStatus),
      );
      await expect.poll(() => backupRequest.mock.calls).toContainEqual([
        { quietGraceMs: 1_000 },
      ]);
      backupRequest.mockRestore();
    },
  );

  it("starts empty, mutates, and persists a deterministic app snapshot", async () => {
    const { data, workspace } = temporaryWorkspace({ withProject: false });
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
      ...runtimeIdentity,
    });
    runtimes.push(runtime);
    expect(new URL(runtime.websocketUrl).hostname).toBe("127.0.0.1");
    expect(new URL(runtime.websocketUrl).pathname).toMatch(/^\/runtime\/[A-Za-z0-9_-]{40,}$/);

    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next((event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome");
    expect(welcome.snapshot.projects).toEqual([]);
    expect(welcome.snapshot.conversations).toEqual([]);
    expect(welcome.snapshot.settings.defaultAccessMode).toBe("supervised");
    expect(welcome.snapshot).not.toHaveProperty("messages");

    const settingsRequestId = randomUUID();
    send(client.socket, {
      type: "settings.update",
      requestId: settingsRequestId,
      payload: { theme: "dark", colorTheme: "iris", compactSidebar: true, terminalFontSize: 15 },
    });
    const settingsResult = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === settingsRequestId,
    );
    expect(settingsResult.requestId).toBe(settingsRequestId);
    const settingsSnapshot = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated",
    );
    expect(settingsSnapshot.snapshot.settings).toMatchObject({ theme: "dark", colorTheme: "iris", compactSidebar: true, terminalFontSize: 15 });

    const projectRequestId = randomUUID();
    send(client.socket, {
      type: "project.create",
      requestId: projectRequestId,
      payload: { name: "Inertia", path: workspace },
    });
    const projectSnapshot = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated",
    );
    const projectCreated = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === projectRequestId
        && event.result.kind === "project.created",
    );
    const project = projectSnapshot.snapshot.projects.find(({ name }) => name === "Inertia");
    expect(project?.path).toBe(workspace);
    expect(
      projectCreated.result.kind === "project.created"
        ? projectCreated.result.projectId
        : null,
    ).toBe(project?.id);

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

    const providerRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.update",
      requestId: providerRequestId,
      payload: { conversationId: conversation?.id, providerId: "claude" },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === providerRequestId,
    );
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.conversations.some(({ id, providerId }) => id === conversation?.id && providerId === "claude"),
    );

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
    const messageDetail = await loadConversationDetail(client.socket, client.events, conversation!.id);
    expect(messageDetail.messages.some(({ content }) => content === "Keep the runtime calm.")).toBe(true);
    expect(messageSnapshot.snapshot.conversations.find(({ id }) => id === conversation?.id)?.providerId).toBe("claude");

    const unsentProviderRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.update",
      requestId: unsentProviderRequestId,
      payload: { conversationId: conversation?.id, providerId: "codex" },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === unsentProviderRequestId,
    );
    const switchedProvider = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.conversations.some(({ id, providerId }) =>
          id === conversation?.id && providerId === "codex"),
    );
    expect(switchedProvider.snapshot.conversations.find(({ id }) =>
      id === conversation?.id)?.providerId).toBe("codex");

    client.socket.close();
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);

    const restarted = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false, ...runtimeIdentity });
    runtimes.push(restarted);
    const persistedClient = await connect(restarted.websocketUrl);
    const persisted = await persistedClient.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    expect(persisted.snapshot.projects).toHaveLength(1);
    expect(persisted.snapshot.settings.theme).toBe("dark");
    const persistedDetail = await loadConversationDetail(
      persistedClient.socket,
      persistedClient.events,
      persisted.snapshot.activeConversationId!,
    );
    expect(persistedDetail.messages.some(({ content }) => content === "Keep the runtime calm.")).toBe(true);
  });

  it("loads settled chats directly and reports missing or deleted detail authoritatively", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
      ...runtimeIdentity,
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const firstId = welcome.snapshot.activeConversationId!;
    const firstProjectId = welcome.snapshot.activeProjectId!;
    expect(welcome.snapshot).not.toHaveProperty("messages");

    const settleRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.settle",
      requestId: settleRequestId,
      payload: { conversationId: firstId },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === settleRequestId,
    );
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.conversations.some(({ id, settledAt }) => id === firstId && settledAt !== null),
    );

    const createRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.create",
      requestId: createRequestId,
      payload: { projectId: firstProjectId, title: "Another chat" },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === createRequestId,
    );
    const created = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.conversations.some(({ title }) => title === "Another chat"),
    );
    const secondId = created.snapshot.conversations.find(({ title }) => title === "Another chat")!.id;

    const secondWorkspace = join(root, "second-workspace");
    mkdirSync(secondWorkspace);
    const projectRequestId = randomUUID();
    send(client.socket, {
      type: "project.create",
      requestId: projectRequestId,
      payload: { name: "Second project", path: secondWorkspace },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.projects.some(({ name }) => name === "Second project"),
    );
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === projectRequestId
        && event.result.kind === "project.created",
    );

    const directSelectRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.select",
      requestId: directSelectRequestId,
      payload: { conversationId: firstId },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === directSelectRequestId,
    );
    const selected = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.activeConversationId === firstId,
    );
    expect(selected.snapshot.activeProjectId).toBe(firstProjectId);
    expect(selected.snapshot.conversations.find(({ id }) => id === firstId)?.settledAt).not.toBeNull();
    expect((await loadConversationDetail(client.socket, client.events, firstId)).conversation.id).toBe(firstId);

    const missingId = randomUUID();
    expect(await loadConversationDetailResult(client.socket, client.events, missingId))
      .toMatchObject({ kind: "conversation.detail", conversationId: missingId, state: "missing" });

    const deleteRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.delete",
      requestId: deleteRequestId,
      payload: { conversationId: secondId },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === deleteRequestId,
    );
    expect(await loadConversationDetailResult(client.socket, client.events, secondId))
      .toMatchObject({ kind: "conversation.detail", conversationId: secondId, state: "deleted" });
  });

  it("creates isolated chats by default and reuses checkout context only when explicitly requested", async () => {
    const { data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false, ...runtimeIdentity });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    const project = welcome.snapshot.projects[0]!;

    const createConversation = async (
      title: string,
      extra: { useWorktree?: boolean; branch?: string | null; worktreePath?: string | null } = {},
    ) => {
      const requestId = randomUUID();
      send(client.socket, {
        type: "conversation.create",
        requestId,
        payload: {
          projectId: project.id,
          title,
          providerId: "codex",
          model: "global-default-model",
          reasoningEffort: "high",
          interactionMode: "build",
          accessMode: "supervised",
          ...extra,
        },
      });
      await client.events.next(
        (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
          event.type === "request.ok" && event.requestId === requestId,
      );
      const snapshot = await client.events.next(
        (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
          event.type === "snapshot.updated"
          && event.snapshot.conversations.some((conversation) => (
            conversation.title === title
            && (!extra.useWorktree || conversation.worktreePath !== null)
          )),
      );
      return snapshot.snapshot.conversations.find((conversation) => conversation.title === title)!;
    };

    const ordinary = await createConversation("Ordinary");
    expect(ordinary).toMatchObject({
      branch: "main",
      worktreePath: null,
      providerSessionId: null,
      providerId: "codex",
      model: "global-default-model",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
    });

    const wrongBranchRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.create",
      requestId: wrongBranchRequestId,
      payload: {
        projectId: project.id,
        title: "Wrong branch",
        branch: "viewed/branch",
      },
    });
    const wrongBranch = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === wrongBranchRequestId,
    );
    expect(wrongBranch.message).toBe("The project checkout is currently on main, not viewed/branch.");

    const isolatedWorktree = await createConversation("Isolated worktree", { useWorktree: true });
    expect(isolatedWorktree.branch).toMatch(/^inertia\/[0-9a-f]{8}$/u);
    expect(isolatedWorktree.worktreePath).toBe(await realpath(join(data, "worktrees", isolatedWorktree.id)));
    expect(isolatedWorktree.providerSessionId).toBeNull();

    const afterViewedWorktree = await createConversation("After viewed worktree");
    expect(afterViewedWorktree).toMatchObject({
      branch: "main",
      worktreePath: null,
      providerSessionId: null,
    });

    const reusedWorktree = await createConversation("Explicitly reused worktree", {
      branch: isolatedWorktree.branch,
      worktreePath: isolatedWorktree.worktreePath,
    });
    expect(reusedWorktree).toMatchObject({
      branch: isolatedWorktree.branch,
      worktreePath: isolatedWorktree.worktreePath,
      providerSessionId: null,
    });

    const deleteConversation = async (conversationId: string) => {
      const requestId = randomUUID();
      send(client.socket, {
        type: "conversation.delete",
        requestId,
        payload: { conversationId },
      });
      return await client.events.next(
        (event): event is Extract<ServerEvent, {
          type: "request.ok" | "request.error";
        }> => (event.type === "request.ok" || event.type === "request.error")
          && event.requestId === requestId,
      );
    };
    expect(await deleteConversation(isolatedWorktree.id)).toMatchObject({
      type: "request.ok",
    });
    expect(existsSync(isolatedWorktree.worktreePath!)).toBe(true);
    expect(await deleteConversation(reusedWorktree.id)).toMatchObject({
      type: "request.error",
      message: expect.stringMatching(/registered.*remove.*manually/iu),
    });
    execFileSync(
      "git",
      ["worktree", "remove", "--force", "--", isolatedWorktree.worktreePath!],
      { cwd: workspace },
    );
    expect(await deleteConversation(reusedWorktree.id)).toMatchObject({
      type: "request.ok",
    });
    expect(existsSync(isolatedWorktree.worktreePath!)).toBe(false);

    const rejectedRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.create",
      requestId: rejectedRequestId,
      payload: {
        projectId: project.id,
        title: "Untrusted checkout",
        branch: "main",
        worktreePath: join(data, "not-a-chat-worktree"),
      },
    });
    const rejected = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === rejectedRequestId,
    );
    expect(rejected.message).toBe("That worktree is not attached to a chat in this project.");

    client.socket.close();
  });

  it("rejects unknown paths and remote web origins", async () => {
    const { data, workspace } = temporaryWorkspace();
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false, ...runtimeIdentity });
    runtimes.push(runtime);

    const url = new URL(runtime.websocketUrl);
    url.pathname = "/runtime/not-the-token";
    await expect(waitForRejectedUpgrade(url.toString(), "http://localhost:5173")).resolves.toBe(404);
    await expect(waitForRejectedUpgrade(runtime.websocketUrl, "https://evil.example")).resolves.toBe(403);
    await expect(waitForRejectedUpgrade(runtime.websocketUrl, "null")).resolves.toBe(403);
  });

  it("returns a scoped request error for malformed or invalid commands", async () => {
    const { data, workspace } = temporaryWorkspace();
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false, ...runtimeIdentity });
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
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false, ...runtimeIdentity });
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
    const runtime = await startRuntime({ dataDirectory: data, defaultWorkspacePath: workspace, enableProviders: false, ...runtimeIdentity });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> => event.type === "server.welcome",
    );
    const projectId = welcome.snapshot.projects[0]!.id;
    const createActionTerminal = async (): Promise<string> => {
      const requestId = randomUUID();
      send(client.socket, { type: "terminal.create", requestId, payload: { projectId, cols: 80, rows: 24 } });
      const created = await client.events.next(
        (event): event is Extract<ServerEvent, { type: "terminal.created" }> => event.type === "terminal.created" && event.requestId === requestId,
      );
      return created.terminalId;
    };

    const actionTerminalId = await createActionTerminal();
    const runRequestId = randomUUID();
    send(client.socket, { type: "project.action.run", requestId: runRequestId, payload: { projectId, actionId: "preview", terminalId: actionTerminalId, cols: 80, rows: 24 } });
    const actionCreated = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "terminal.created" }> => event.type === "terminal.created" && event.requestId === runRequestId,
    );
    expect(actionCreated.terminalId === actionTerminalId)
      .toBe(process.platform !== "darwin");
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

    const rerunTerminalId = await createActionTerminal();
    const rerunRequestId = randomUUID();
    send(client.socket, { type: "project.action.run", requestId: rerunRequestId, payload: { projectId, actionId: activity.actionId, terminalId: rerunTerminalId, cols: 80, rows: 24 } });
    const rerunCreated = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "terminal.created" }> => event.type === "terminal.created" && event.requestId === rerunRequestId,
    );
    expect(rerunCreated.terminalId === rerunTerminalId)
      .toBe(process.platform !== "darwin");
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
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) =>
          run.id === activity.id && run.attentionState === "dismissed"),
    );
    expect(dismissed.snapshot.runs.find((run) => run.id === activity.id)).toMatchObject({
      status: "cancelled",
      attentionState: "dismissed",
    });
  });

  it("updates a matching provider activity instead of persisting duplicate lifecycle rows", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    const { authFile, executable } = fakeCodex(root, [
      { type: "item.started", item: { id: "command-activity", type: "command_execution", command: "npm test" } },
      { type: "item.completed", item: { id: "command-activity", type: "command_execution", command: "npm test" } },
      { type: "item.completed", item: { type: "agent_message", text: "Activity lifecycle complete." } },
      { type: "turn.completed" },
    ]);
    writeFileSync(authFile, "connected");
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      ...runtimeIdentity,
      codexBinaryPath: executable,
    });
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
    await loadConversationDetail(client.socket, client.events, conversationId!);

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
    const accepted = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === messageRequestId
        && event.result.kind === "message.accepted",
    );
    expect(accepted.result).toMatchObject({
      kind: "message.accepted",
      conversationId,
      disposition: "new-turn",
    });
    const started = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "agent.activity" }> =>
        event.type === "agent.activity" && event.activity.kind === "command" && event.activity.status === "running",
    );
    const runningCheck = await client.events.next(
      (event): event is Extract<
        ServerEvent,
        { type: "conversation.shell.updated" }
      > =>
        event.type === "conversation.shell.updated"
        && event.conversation.id === conversationId
        && event.runs.some((run) =>
          run.conversationId === conversationId
          && run.kind === "check"
          && run.label === "npm test"
          && run.status === "running"),
    );
    const commandRun = runningCheck.runs.find((run) =>
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
      (event): event is Extract<
        ServerEvent,
        { type: "conversation.shell.updated" }
      > =>
        event.type === "conversation.shell.updated"
        && event.conversation.id === conversationId
        && event.runs.some((run) =>
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
        && event.snapshot.conversations.some((thread) =>
          thread.id === conversationId
          && thread.latestTurn?.runId === started.activity.runId
          && thread.latestTurn.status === "completed"),
    );
    expect(persisted.snapshot).not.toHaveProperty("messages");
    const persistedDetail = await waitForConversationDetail(
      client.socket,
      client.events,
      conversationId!,
      (detail) => detail.turnGitArtifacts.some((artifact) =>
        artifact.turnId === started.activity.turnId
        && artifact.status === "ready"
        && artifact.completeness === "complete"),
    );
    expect(persistedDetail.activities.filter((activity) => activity.runId === started.activity.runId && activity.kind === "command")).toEqual([
      expect.objectContaining({ id: started.activity.id, status: "completed", turnId: started.activity.turnId }),
    ]);
    const turn = persistedDetail.agentTurns.find(({ runId }) => runId === started.activity.runId);
    expect(turn).toMatchObject({
      id: started.activity.turnId,
      conversationId,
      association: "authoritative",
      userMessageId: expect.any(String),
    });
    expect(persistedDetail.messages.filter(({ turnId }) => turnId === turn?.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: turn?.userMessageId, role: "user" }),
      expect.objectContaining({ role: "assistant" }),
    ]));
    const turnArtifact = persistedDetail.turnGitArtifacts.find(({ turnId }) => turnId === turn?.id);
    expect(turnArtifact).toMatchObject({
      conversationId,
      runId: turn?.runId,
      status: "ready",
      patchState: "available",
      files: [],
    });
    const turnDiffRequestId = randomUUID();
    send(client.socket, {
      type: "git.turn.diff",
      requestId: turnDiffRequestId,
      payload: {
        projectId: ready.activeProjectId,
        conversationId,
        turnId: turn!.id,
      },
    });
    const historicalDiff = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === turnDiffRequestId
        && event.result.kind === "git.turn.diff",
    );
    expect(historicalDiff.result).toMatchObject({
      kind: "git.turn.diff",
      diff: {
        turnId: turn?.id,
        completeness: "complete",
        patch: "",
        files: [],
      },
    });
    expect(persisted.snapshot.runs).toContainEqual(expect.objectContaining({
      id: commandRun?.id,
      kind: "check",
      label: "npm test",
      status: "succeeded",
      canStop: false,
    }));

    const crossHarnessRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.update",
      requestId: crossHarnessRequestId,
      payload: { conversationId, providerId: "claude" },
    });
    const rejectedSwitch = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error"
        && event.requestId === crossHarnessRequestId,
    );
    expect(rejectedSwitch.message).toBe(
      "Start a new chat to use a different agent harness. Existing chats keep their original agent context.",
    );
    expect((await loadConversationDetail(
      client.socket,
      client.events,
      conversationId!,
    )).conversation.providerId).toBe("codex");
  });

  it("invalidates reviewed targets and notes immediately after committing their change", async () => {
    const { data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
      ...runtimeIdentity,
      secureFiles: new SecureFileTestBroker(),
    });
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
    const requestDeadlineAt = Date.now() + 30_000;

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
    await client.events.nextForRequest(
      stateRequestId,
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === stateRequestId,
      requestDeadlineAt,
    );
    expect((await loadConversationDetail(
      client.socket,
      client.events,
      conversationId,
      requestDeadlineAt,
    )).reviewStates)
      .toContainEqual(expect.objectContaining({
        conversationId,
        path: file.path,
        reviewed: true,
        stale: false,
      }));

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
    await client.events.nextForRequest(
      noteRequestId,
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === noteRequestId,
      requestDeadlineAt,
    );
    expect((await loadConversationDetail(
      client.socket,
      client.events,
      conversationId,
      requestDeadlineAt,
    )).reviewNotes)
      .toContainEqual(expect.objectContaining({
        conversationId,
        path: file.path,
        stale: false,
      }));

    const statusRequestId = randomUUID();
    send(client.socket, {
      type: "git.refresh",
      requestId: statusRequestId,
      payload: { projectId, conversationId },
    });
    const statusResult = await client.events.nextForRequest(
      statusRequestId,
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === statusRequestId
        && event.result.kind === "git.status",
      requestDeadlineAt,
    );
    expect(statusResult.result.kind).toBe("git.status");
    if (statusResult.result.kind !== "git.status") throw new Error("Expected Git status.");
    const statusAuthorityRef = statusResult.result.status.authorityRef;
    if (!statusAuthorityRef) throw new Error("Expected Git status authority.");
    const diffRequestId = randomUUID();
    send(client.socket, {
      type: "git.diff",
      requestId: diffRequestId,
      payload: {
        projectId,
        conversationId,
        authorityRef: statusAuthorityRef,
        ignoreWhitespace: false,
        commitReview: true,
      },
    });
    const diffResult = await client.events.nextForRequest(
      diffRequestId,
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === diffRequestId
        && event.result.kind === "git.diff",
      requestDeadlineAt,
    );
    expect(diffResult.result.kind).toBe("git.diff");
    if (diffResult.result.kind !== "git.diff") throw new Error("Expected Git diff.");
    const reviewReceipt = diffResult.result.diff.commitReview;
    if (!reviewReceipt) throw new Error("Expected commit review receipt.");

    const commitRequestId = randomUUID();
    send(client.socket, {
      type: "git.commit",
      requestId: commitRequestId,
      payload: {
        projectId,
        conversationId,
        message: "Commit reviewed change",
        paths: [file.path],
        reviewReceipt,
      },
    });
    await client.events.nextForRequest(
      commitRequestId,
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === commitRequestId
        && event.result.kind === "git.action",
      requestDeadlineAt,
    );
    const invalidated = await loadConversationDetail(
      client.socket,
      client.events,
      conversationId,
      requestDeadlineAt,
    );
    expect(invalidated.reviewStates).toContainEqual(expect.objectContaining({
      conversationId,
      path: file.path,
      reviewed: false,
      stale: true,
    }));
    expect(invalidated.reviewNotes).toContainEqual(expect.objectContaining({
      conversationId,
      path: file.path,
      body: "Keep this review checkpoint after the commit.",
      stale: true,
    }));
  }, 30_000);

  it("scopes review state and notes to the selected file when the repository diff exceeds its file limit", async () => {
    const { data, workspace } = temporaryWorkspace();
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "runtime@example.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Runtime Test"], { cwd: workspace });
    for (let index = 0; index < 51; index += 1) {
      writeFileSync(
        join(workspace, `review-${index.toString().padStart(2, "0")}.ts`),
        `export const value = "before-${index}";\n`,
      );
    }
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
    for (let index = 0; index < 51; index += 1) {
      writeFileSync(
        join(workspace, `review-${index.toString().padStart(2, "0")}.ts`),
        `export const value = "after-${index}";\n`,
      );
    }

    expect((await getUnifiedDiff(workspace)).truncated).toBe(true);
    const targetPath = "review-50.ts";
    const selected = parseUnifiedDiff((await getUnifiedDiff(workspace, {
      paths: [targetPath],
    })).text);
    const file = selected.files[0]!;
    const targetFingerprint = diffFileFingerprint(file);
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
      ...runtimeIdentity,
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const conversationId = welcome.snapshot.activeConversationId!;

    const stateRequestId = randomUUID();
    send(client.socket, {
      type: "review.state.set",
      requestId: stateRequestId,
      payload: {
        conversationId,
        scope: "file",
        path: targetPath,
        hunkId: null,
        targetFingerprint,
        reviewed: true,
      },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === stateRequestId,
    );

    const noteRequestId = randomUUID();
    send(client.socket, {
      type: "review.note.create",
      requestId: noteRequestId,
      payload: {
        conversationId,
        path: targetPath,
        hunkId: null,
        lineIds: [],
        targetFingerprint,
        body: "Selected-file note in a large change set.",
      },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === noteRequestId,
    );

    const detail = await loadConversationDetail(
      client.socket,
      client.events,
      conversationId,
    );
    expect(detail.reviewStates).toContainEqual(expect.objectContaining({
      path: targetPath,
      reviewed: true,
      stale: false,
    }));
    expect(detail.reviewNotes).toContainEqual(expect.objectContaining({
      path: targetPath,
      body: "Selected-file note in a large change set.",
      stale: false,
    }));
  });

  it("persists review metadata and safely reverts selections in a nested repository", async () => {
    const requestDeadlineAt = Date.now() + 30_000;
    const { data, workspace } = temporaryWorkspace();
    const repositoryPath = "modules/example";
    const nested = join(workspace, repositoryPath);
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: nested });
    execFileSync("git", ["config", "user.email", "runtime@example.invalid"], { cwd: nested });
    execFileSync("git", ["config", "user.name", "Runtime Test"], { cwd: nested });
    writeFileSync(join(nested, "review.ts"), "export const enabled = false;\n");
    writeFileSync(join(nested, "other.ts"), "export const count = 1;\n");
    execFileSync("git", ["add", "review.ts", "other.ts"], { cwd: nested });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: nested });
    writeFileSync(join(nested, "review.ts"), "export const enabled = true;\n");
    writeFileSync(join(nested, "other.ts"), "export const count = 2;\n");

    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
      ...runtimeIdentity,
      secureFiles: new SecureFileTestBroker(),
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const projectId = welcome.snapshot.activeProjectId!;
    const conversationId = welcome.snapshot.activeConversationId!;
    const workspaceRefreshRequestId = randomUUID();
    send(client.socket, {
      type: "git.workspace.refresh",
      requestId: workspaceRefreshRequestId,
      payload: { projectId, conversationId },
    });
    const workspaceRefresh = await client.events.nextForRequest(
      workspaceRefreshRequestId,
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.result.kind === "git.workspace.status",
      requestDeadlineAt,
    );
    if (workspaceRefresh.result.kind !== "git.workspace.status") {
      throw new Error("Expected a workspace repository refresh.");
    }
    const repositoryAuthority = workspaceRefresh.result.status.repositories
      .find((candidate) => candidate.repositoryPath === repositoryPath)
      ?.authorityRef;
    if (!repositoryAuthority) {
      throw new Error("Expected a nested repository authority.");
    }
    const diff = parseUnifiedDiff((await getUnifiedDiff(nested, {
      paths: ["review.ts"],
    })).text);
    const file = diff.files[0]!;
    const hunk = file.hunks[0]!;
    const lineIds = hunk.lines
      .filter(({ kind }) => kind === "addition" || kind === "deletion")
      .map(({ id }) => id);
    const targetFingerprint = diffHunkFingerprint(file, hunk);

    const stateRequestId = randomUUID();
    send(client.socket, {
      type: "review.state.set",
      requestId: stateRequestId,
      payload: {
        conversationId,
        repositoryPath,
        scope: "hunk",
        path: file.path,
        hunkId: hunk.id,
        targetFingerprint,
        reviewed: true,
      },
    });
    await client.events.nextForRequest(
      stateRequestId,
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok",
      requestDeadlineAt,
    );

    const noteRequestId = randomUUID();
    send(client.socket, {
      type: "review.note.create",
      requestId: noteRequestId,
      payload: {
        conversationId,
        repositoryPath,
        path: file.path,
        hunkId: hunk.id,
        lineIds: [],
        targetFingerprint,
        body: "Nested repository note.",
      },
    });
    await client.events.nextForRequest(
      noteRequestId,
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok",
      requestDeadlineAt,
    );

    const detail = await loadConversationDetail(
      client.socket,
      client.events,
      conversationId,
    );
    expect(detail.reviewStates).toContainEqual(expect.objectContaining({
      repositoryPath,
      path: file.path,
      reviewed: true,
      stale: false,
    }));
    expect(detail.reviewNotes).toContainEqual(expect.objectContaining({
      repositoryPath,
      path: file.path,
      body: "Nested repository note.",
      stale: false,
    }));

    const selectedDiffRequestId = randomUUID();
    send(client.socket, {
      type: "git.workspace.diff",
      requestId: selectedDiffRequestId,
      payload: {
        projectId,
        conversationId,
        authorityRef: repositoryAuthority,
        repositoryPath,
        path: file.path,
      },
    });
    const selectedDiff = await client.events.nextForRequest(
      selectedDiffRequestId,
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.result.kind === "git.workspace.diff",
      requestDeadlineAt,
    );
    if (selectedDiff.result.kind !== "git.workspace.diff") {
      throw new Error("Expected a selected nested diff.");
    }
    expect(selectedDiff.result.diff.reviewMetadataChanged).toBe(false);
    expect(selectedDiff.result.diff.patch).toContain("review.ts");
    expect(selectedDiff.result.diff.patch).not.toContain("other.ts");

    const inspectRequestId = randomUUID();
    send(client.socket, {
      type: "git.selection.inspect",
      requestId: inspectRequestId,
      payload: {
        projectId,
        conversationId,
        repositoryPath,
        fingerprint: diff.fingerprint,
        filePath: file.path,
        hunkId: hunk.id,
        lineIds,
      },
    });
    const inspected = await client.events.nextForRequest(
      inspectRequestId,
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.result.kind === "git.reversal.plan",
      requestDeadlineAt,
    );
    if (inspected.result.kind !== "git.reversal.plan") {
      throw new Error("Expected a nested reversal plan.");
    }

    const revertRequestId = randomUUID();
    send(client.socket, {
      type: "git.selection.revert",
      requestId: revertRequestId,
      payload: {
        projectId,
        conversationId,
        repositoryPath,
        fingerprint: diff.fingerprint,
        filePath: file.path,
        hunkId: hunk.id,
        lineIds,
        authorityRef: inspected.result.plan.authorityRef,
        expected: inspected.result.plan.validation,
      },
    });
    const reverted = await client.events.nextForRequest(
      revertRequestId,
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.result.kind === "git.reversal",
      requestDeadlineAt,
    );
    if (reverted.result.kind !== "git.reversal") {
      throw new Error("Expected a nested reversal result.");
    }
    expect(reverted.result.operation.repositoryPath).toBe(repositoryPath);
    expect(readFileSync(join(nested, "review.ts"), "utf8")).toContain(
      "enabled = false",
    );

    const refreshRequestId = randomUUID();
    send(client.socket, {
      type: "git.workspace.diff",
      requestId: refreshRequestId,
      payload: {
        projectId,
        conversationId,
        authorityRef: repositoryAuthority,
        repositoryPath,
        path: file.path,
      },
    });
    const refreshedDiff = await client.events.nextForRequest(
      refreshRequestId,
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.result.kind === "git.workspace.diff",
      requestDeadlineAt,
    );
    if (refreshedDiff.result.kind !== "git.workspace.diff") {
      throw new Error("Expected a reconciled nested diff.");
    }
    expect(refreshedDiff.result.diff.reviewMetadataChanged).toBe(true);
    const reconciled = await loadConversationDetail(
      client.socket,
      client.events,
      conversationId,
    );
    expect(reconciled.reviewStates).toContainEqual(expect.objectContaining({
      repositoryPath,
      path: file.path,
      hunkId: hunk.id,
      reviewed: false,
      stale: true,
    }));
    expect(reconciled.reviewNotes).toContainEqual(expect.objectContaining({
      repositoryPath,
      path: file.path,
      hunkId: hunk.id,
      body: "Nested repository note.",
      stale: true,
    }));

    const undoRequestId = randomUUID();
    send(client.socket, {
      type: "git.selection.undo",
      requestId: undoRequestId,
      payload: {
        projectId,
        conversationId,
        repositoryPath,
        operationId: reverted.result.operation.id,
        authorityRef: reverted.result.operation.authorityRef,
      },
    });
    await client.events.nextForRequest(
      undoRequestId,
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.result.kind === "git.diff",
      requestDeadlineAt,
    );
    expect(readFileSync(join(nested, "review.ts"), "utf8")).toContain(
      "enabled = true",
    );
  }, 30_000);

  it("applies the persisted project repository display limit during workspace refresh", async () => {
    const { data, workspace } = temporaryWorkspace();
    for (let index = 0; index < 17; index += 1) {
      const repository = join(
        workspace,
        "modules",
        `repository-${String(index).padStart(2, "0")}`,
      );
      mkdirSync(repository, { recursive: true });
      execFileSync("git", ["init", "--initial-branch=main"], {
        cwd: repository,
      });
    }

    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: false,
      ...runtimeIdentity,
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const project = welcome.snapshot.projects.find(
      ({ id }) => id === welcome.snapshot.activeProjectId,
    )!;
    expect(project.gitRepositoryLimit).toBe(128);

    const updateRequestId = randomUUID();
    send(client.socket, {
      type: "project.update",
      requestId: updateRequestId,
      payload: {
        projectId: project.id,
        gitRepositoryLimit: 16,
      },
    });
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === updateRequestId,
    );
    const updated = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.projects.some(
          (candidate) => (
            candidate.id === project.id
            && candidate.gitRepositoryLimit === 16
          ),
        ),
    );
    expect(updated.snapshot.projects.find(({ id }) => id === project.id))
      .toMatchObject({ gitRepositoryLimit: 16 });

    const requestId = randomUUID();
    send(client.socket, {
      type: "git.workspace.refresh",
      requestId,
      payload: { projectId: project.id },
    });
    const refreshed = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === requestId
        && event.result.kind === "git.workspace.status",
    );
    if (refreshed.result.kind !== "git.workspace.status") {
      throw new Error("Expected workspace repository status.");
    }
    expect(refreshed.result.status.repositories).toHaveLength(16);
    expect(refreshed.result.status.discoveredRepositories).toBe(17);
    expect(refreshed.result.status.repositoryLimit).toBe(16);
  });

  it("rejects a known-unready provider before persisting a turn, then refreshes its state", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    const { authFile, executable } = fakeCodex(root);
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      ...runtimeIdentity,
      codexBinaryPath: executable,
    });
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
    const conversationId = signedOut.activeConversationId;
    expect(conversationId).toBeTruthy();
    const initialDetail = await loadConversationDetail(client.socket, client.events, conversationId!);
    const initialMessageCount = initialDetail.messages.length;
    const initialCheckpointCount = initialDetail.checkpoints.length;

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
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => event.type === "snapshot.updated",
    );
    const unchanged = await loadConversationDetail(client.socket, client.events, conversationId!);
    expect(unchanged.messages).toHaveLength(initialMessageCount);
    expect(unchanged.messages.some(({ content }) => content === "This turn must not be stored.")).toBe(false);
    expect(unchanged.checkpoints).toHaveLength(initialCheckpointCount);

    writeFileSync(authFile, "connected");
    const refreshRequestId = randomUUID();
    send(client.socket, { type: "provider.refresh", requestId: refreshRequestId, payload: { providerId: "codex" } });
    const connected = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.providers.some((provider) => provider.id === "codex" && providerReady(provider)),
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
    const { executable } = fakeCodex(root);
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      ...runtimeIdentity,
      codexBinaryPath: executable,
    });
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
        event.type === "snapshot.updated"
        && event.snapshot.providers.some((provider) => provider.id === "codex" && providerReady(provider)),
    );
    expect(connected.snapshot.providers.find(({ id }) => id === "codex")).toMatchObject({
      installState: "installed",
      authState: "authenticated",
      canRun: true,
    });
    expect(existsSync(join(root, "codex-authenticated"))).toBe(true);
  });

  summaryRuntimeIt("returns selection Ask as an isolated contextual result without creating transcript records", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    writeFileSync(join(workspace, "other.ts"), "export const count = 1;\n");
    execFileSync("git", ["add", "other.ts"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "add other file"], { cwd: workspace });
    writeFileSync(join(workspace, "other.ts"), "export const count = 2;\n");
    const diff = await getUnifiedDiff(workspace, { paths: ["review.ts"] });
    const structured = parseUnifiedDiff(diff.text);
    const file = structured.files[0]!;
    const hunk = file.hunks[0]!;
    const lineIds = hunk.lines
      .filter(({ kind }) => kind === "addition" || kind === "deletion")
      .map(({ id }) => id);
    const { authFile, executable } = fakeCodex(root, [
      { type: "item.completed", item: { type: "agent_message", text: "This changes the exported behavior while keeping the review task isolated." } },
      { type: "turn.completed" },
    ]);
    writeFileSync(authFile, "connected");
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      ...runtimeIdentity,
      codexBinaryPath: executable,
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const ready = await providerSnapshot(
      client.events,
      welcome.snapshot,
      "codex",
      (provider) => provider.canRun,
    );
    const conversationId = ready.activeConversationId!;
    const requestId = randomUUID();
    send(client.socket, {
      type: "review.selection.ask",
      requestId,
      payload: {
        projectId: ready.activeProjectId!,
        conversationId,
        fingerprint: structured.fingerprint,
        filePath: file.path,
        hunkId: hunk.id,
        lineIds,
        comment: "Why does this change matter?",
      },
    });

    const result = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === requestId
        && event.result.kind === "review.selection.answer",
    );
    expect(result.result).toMatchObject({
      kind: "review.selection.answer",
      answer: {
        conversationId,
        fingerprint: structured.fingerprint,
        filePath: file.path,
        hunkId: hunk.id,
        selectedLineCount: lineIds.length,
        question: "Why does this change matter?",
        providerId: "codex",
        modelSelection: {
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          modelId: "provider-default",
        },
      },
    });
    if (result.result.kind === "review.selection.answer") {
      expect(result.result.answer.answer).toContain("keeping the review task isolated");
      expect(result.result.answer).not.toHaveProperty("executionPrompt");
      expect(result.result.answer).not.toHaveProperty("providerSessionId");
    }
    const detail = await loadConversationDetail(client.socket, client.events, conversationId);
    expect(detail.messages).toEqual([]);
    expect(detail.agentTurns).toEqual([]);
    expect(detail.conversation.providerSessionId).toBeNull();
  });

  summaryRuntimeIt("leaves no phantom selection question when isolated Ask fails closed", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    const diff = await getUnifiedDiff(workspace);
    const structured = parseUnifiedDiff(diff.text);
    const file = structured.files[0]!;
    const hunk = file.hunks[0]!;
    const { authFile, executable } = fakeCodex(root, [{ type: "approval.request" }]);
    writeFileSync(authFile, "connected");
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      ...runtimeIdentity,
      codexBinaryPath: executable,
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const ready = await providerSnapshot(
      client.events,
      welcome.snapshot,
      "codex",
      (provider) => provider.canRun,
    );
    const conversationId = ready.activeConversationId!;
    const requestId = randomUUID();
    send(client.socket, {
      type: "review.selection.ask",
      requestId,
      payload: {
        projectId: ready.activeProjectId!,
        conversationId,
        fingerprint: structured.fingerprint,
        filePath: file.path,
        hunkId: hunk.id,
        lineIds: [hunk.lines.find(({ kind }) => kind !== "meta")!.id],
        comment: "Can you check this?",
      },
    });

    const failed = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === requestId,
    );
    expect(failed.message).toMatch(/unsupported interaction/u);
    const detail = await loadConversationDetail(client.socket, client.events, conversationId);
    expect(detail.messages).toEqual([]);
    expect(detail.agentTurns).toEqual([]);
  });

  summaryRuntimeIt("runs diff summaries in an isolated session, exposes workspace-run status, and cleans up without contaminating the thread", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    const diff = await getUnifiedDiff(workspace);
    const { authFile, executable } = fakeCodex(root, [
      { type: "item.completed", item: { type: "agent_message", text: reviewResult(diff.text) } },
      { type: "turn.completed" },
    ]);
    writeFileSync(authFile, "connected");
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      ...runtimeIdentity,
      codexBinaryPath: executable,
    });
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
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      model: null,
      classifications: [{ classification: "behavior-change" }],
    });
    const completed = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) => run.conversationId === conversationId && run.label.includes("read-only diff summary") && run.status === "succeeded"),
    );
    expect(completed.snapshot.conversations.find(({ id }) => id === conversationId)?.providerSessionId).toBeNull();
    expect((await loadConversationDetail(client.socket, client.events, conversationId)).reviewSummaries).toEqual([
      result.result.kind === "review.summary" ? result.result.summary : null,
    ]);
    expect(readFileSync(join(workspace, "review.ts"), "utf8")).toBe("export const enabled = true;\n");

    for (let attempt = 0; attempt < 20 && readdirSync(data).some((name) => name.startsWith("read-only-summary-")); attempt += 1) {
      await delay(10);
    }
    expect(readdirSync(data).filter((name) => name.startsWith("read-only-summary-"))).toEqual([]);
  });

  summaryRuntimeIt("deduplicates and explicitly cancels an active diff summary with recoverable workspace-run cleanup", async () => {
    const { root, data, workspace } = temporaryWorkspace();
    initializeChangedRepository(workspace);
    const diff = await getUnifiedDiff(workspace);
    const { authFile, executable } = fakeCodex(root);
    writeFileSync(authFile, "connected");
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      ...runtimeIdentity,
      codexBinaryPath: executable,
    });
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
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) => run.conversationId === conversationId && run.label.includes("read-only diff summary") && run.status === "cancelled"),
    );
    expect((await loadConversationDetail(client.socket, client.events, conversationId)).reviewSummaries).toEqual([]);
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
      const { authFile, executable } = fakeCodex(root, runEvents);
      writeFileSync(authFile, "connected");
      const runtime = await startRuntime({
        dataDirectory: data,
        defaultWorkspacePath: workspace,
        enableProviders: true,
      ...runtimeIdentity,
        codexBinaryPath: executable,
      });
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
      await client.events.next(
        (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
          event.type === "snapshot.updated"
          && event.snapshot.runs.some((run) => run.conversationId === conversationId && run.label.includes("read-only diff summary") && run.status === "failed"),
      );
      expect((await loadConversationDetail(client.socket, client.events, conversationId)).reviewSummaries).toEqual([]);
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
    const { authFile, executable } = fakeCodex(root);
    writeFileSync(authFile, "connected");
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      ...runtimeIdentity,
      codexBinaryPath: executable,
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
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.runs.some((run) => run.label.includes("read-only diff summary") && run.status === "failed"),
    );
    expect((await loadConversationDetail(
      client.socket,
      client.events,
      ready.activeConversationId!,
    )).reviewSummaries).toEqual([]);
    expect(readdirSync(data).filter((name) => name.startsWith("read-only-summary-"))).toEqual([]);
    client.socket.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
  });
});
