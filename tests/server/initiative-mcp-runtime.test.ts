import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import * as providerEnvironmentModule from "../../src/server/environment";
import type { RuntimeBackendCredentialBroker } from "../../src/server/runtime-types";
import { initiativeMcpSecretReference } from "../../src/node/initiative-mcp-secret-reference";
import { initiativeMcpServerDestination } from "../../src/shared/initiative-mcp";
import { providerDriftEnvironment, providerDriftEnvironmentDirectories } from "../../scripts/provider-drift-environment.mjs";
import { writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { connectRuntime as connect, type RuntimeEventQueue } from "../support/runtime-event-queue";
import { loadConversationDetail } from "../support/runtime-conversation-detail";
import { startTestRuntime as startRuntime } from "../support/test-runtime";
import { RuntimeTestCleanup } from "../support/runtime-test-cleanup";

/*
 * End to end through the runtime: an initiative MCP secret held only by the
 * credential broker reaches the provider's thread/start request when a member
 * chat's turn starts, and nothing the runtime persists or publishes (the
 * SQLite files, snapshots, conversation detail) ever contains it, even when
 * the provider repeats it split across streamed text and reasoning deltas.
 */

const SECRET = "fixture-runtime-mcp-secret-6a3c91";
const SERVER_ID = "55555555-5555-4555-8555-555555555555";

function send(socket: WebSocket, command: object): void { socket.send(JSON.stringify(command)); }

function providerReady(provider: ProviderInfo): boolean {
  const { models, rateLimits } = provider.metadataState;
  return provider.authState === "authenticated" && provider.canRun && models.lastAttemptedAt !== null
    && rateLimits.lastAttemptedAt !== null && !models.refreshing && !rateLimits.refreshing;
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(entry.parentPath, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}

describe.skipIf(process.platform === "win32")("initiative MCP secrets through the runtime", () => {
  const cleanup = new RuntimeTestCleanup();
  afterEach(async () => {
    try { await cleanup.close(); } finally { vi.restoreAllMocks(); }
  });

  function fakeCodex(root: string, capturePath: string): string {
    const executableDirectory = join(root, "provider-bin");
    const commandCwd = join(root, "workspace");
    mkdirSync(executableDirectory);
    writeNodeSubcommand(commandCwd, "login", `
if (process.argv[2] === "status") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }
process.exit(1);
`);
    writeNodeSubcommand(commandCwd, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--help") { process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n"); process.exit(0); }
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let threadId = "mcp-runtime-thread";
// Whether this session was opened with the tracker server and its secret.
let received = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "config/read") return send({ id: message.id, result: { config: { mcp_servers: {} } } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
    threadId = message.params.threadId || threadId;
    received = Boolean(message.params.config && message.params.config["mcp_servers.tracker"]);
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fake" } });
  }
  if (message.method === "turn/start") {
    fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
    const turn = { id: "mcp-runtime-turn", status: "inProgress", items: [], error: null };
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId, turn } });
    // In the session that received it, the provider repeats the secret,
    // split across reasoning and text deltas.
    if (!received) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "answer", delta: "Checked the docs." } });
      return send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
    }
    for (const delta of ${JSON.stringify(["Token is ", SECRET.slice(0, 9), SECRET.slice(9, 20), `${SECRET.slice(20)}.`])}) {
      send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId: turn.id, itemId: "think", summaryIndex: 0, delta } });
    }
    for (const delta of ${JSON.stringify(["Used the tracker with ", SECRET.slice(0, 12), `${SECRET.slice(12)}.`])}) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "answer", delta } });
    }
    return send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
  }
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
});
`);
    const executable = join(executableDirectory, "codex");
    writeFileSync(executable, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write(${JSON.stringify(process.version)} + "\\n"); process.exit(0); }
const script = args[0] === "login" ? ${JSON.stringify(join(commandCwd, "login"))}
  : args[0] === "app-server" ? ${JSON.stringify(join(commandCwd, "app-server"))} : null;
if (!script) process.exit(2);
const child = spawnSync(process.execPath, [script, ...args.slice(1)], { stdio: "inherit" });
process.exit(child.status ?? 1);
`);
    chmodSync(executable, 0o755);
    const environment = providerDriftEnvironment(join(root, "provider-profile"), {
      PATH: [executableDirectory, dirname(process.execPath)].join(delimiter),
    });
    for (const path of providerDriftEnvironmentDirectories(environment)) mkdirSync(path, { recursive: true, mode: 0o700 });
    vi.spyOn(providerEnvironmentModule, "providerEnvironment").mockResolvedValue({
      env: environment,
      pathEntries: [executableDirectory],
    });
    return executable;
  }

  async function request(socket: WebSocket, events: RuntimeEventQueue, type: string, payload: object): Promise<ServerEvent> {
    const requestId = randomUUID();
    send(socket, { type, requestId, payload });
    return await events.next((event): event is ServerEvent =>
      (event.type === "request.ok" || event.type === "request.result" || event.type === "request.error")
      && "requestId" in event && event.requestId === requestId);
  }

  it("resolves the secret only into the provider request and never persists or publishes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-initiative-mcp-runtime-"));
    cleanup.directories.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    mkdirSync(data);
    const seed = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
    const project = seed.createProject("Checkout", workspace);
    const conversation = seed.createConversation(project.id, "Checkout form");
    seed.close();
    const capturePath = join(root, "codex-requests.jsonl");
    const executable = fakeCodex(root, capturePath);

    // The broker stands in for the main-process vault: it alone holds the value.
    const vault = new Map<string, string>();
    const broker: RuntimeBackendCredentialBroker = {
      resolve: async (reference) => vault.get(reference) ?? null,
      has: async (reference) => vault.has(reference),
      status: async (reference) => ({ hasSecret: vault.has(reference), credentialGeneration: null }),
      clear: async () => false,
      forget: async (reference) => vault.delete(reference),
    };
    const runtime = await startRuntime({
      dataDirectory: data,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      runtimeGenerationId: "00000000-0000-4000-8000-000000000055:1",
      systemBootId: "test:00000000-0000-4000-8000-000000000055",
      codexBinaryPath: executable,
      backendCredentials: broker,
    });
    cleanup.runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    // Every frame the runtime publishes to the renderer during the scenario.
    const published: string[] = [];
    client.socket.on("message", (data) => { published.push(String(data)); });
    const welcome = await client.events.next((event): event is Extract<ServerEvent, { type: "server.welcome" }> => {
      published.push(JSON.stringify(event));
      return event.type === "server.welcome";
    });
    const ready = welcome.snapshot.providers.some((provider) => provider.id === "codex" && providerReady(provider))
      ? welcome.snapshot
      : (await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated" && event.snapshot.providers.some((provider) => provider.id === "codex" && providerReady(provider)))).snapshot;
    expect(ready.conversations.some(({ id }) => id === conversation.id)).toBe(true);

    const createdResponse = await request(client.socket, client.events, "initiative.create", { id: randomUUID(), name: "Checkout", conversationId: conversation.id });
    expect(createdResponse, JSON.stringify(createdResponse)).toMatchObject({ type: "request.ok" });
    const created = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated" && (event.snapshot.initiatives ?? []).length === 1);
    const initiative = created.snapshot.initiatives![0]!;
    expect(await request(client.socket, client.events, "initiative.update", {
      id: initiative.id,
      expectedRevision: initiative.revision,
      preferences: {
        mcpServers: [{
          id: SERVER_ID,
          name: "tracker",
          enabled: true,
          transport: { kind: "http", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", secret: true }] },
        }],
      },
    })).toMatchObject({ type: "request.ok" });
    // What main stores after the renderer submits the value once.
    vault.set(initiativeMcpSecretReference(initiative.id, SERVER_ID, "header:authorization", initiativeMcpServerDestination({
      transport: { kind: "http", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", secret: true }] },
    })), `Bearer ${SECRET}`);

    expect(await request(client.socket, client.events, "message.send", { conversationId: conversation.id, content: "File the checkout bug." }))
      .toMatchObject({ type: "request.result" });
    const settled = await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> => {
      published.push(JSON.stringify(event));
      return event.type === "snapshot.updated"
        && event.snapshot.conversations.some(({ id, latestTurn }) => id === conversation.id && latestTurn?.status === "completed");
    });
    published.push(JSON.stringify(settled));

    const requests = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: { config?: Record<string, { http_headers?: Record<string, string> }> };
    });
    const started = requests.find(({ method }) => method === "thread/start")!;
    expect(started.params.config?.["mcp_servers.tracker"]).toEqual({
      url: "https://mcp.example.com/mcp",
      http_headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(requests.filter(({ method }) => method === "turn/start").map((line) => JSON.stringify(line)).join("\n"))
      .not.toContain(SECRET);

    // The chat's next message resumes the same Codex thread, and Codex loads
    // MCP servers with the session's config, so the resumed thread receives
    // the initiative's current set: here the server turned off.
    expect(await request(client.socket, client.events, "initiative.update", {
      id: initiative.id,
      // The first update moved the revision on by one.
      expectedRevision: initiative.revision + 1,
      preferences: {
        mcpServers: [{
          id: SERVER_ID,
          name: "tracker",
          enabled: false,
          transport: { kind: "http", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", secret: true }] },
        }, {
          id: randomUUID(),
          name: "docs",
          enabled: true,
          transport: { kind: "http", url: "https://docs.example.com/mcp", headers: [{ name: "X-Team", value: "checkout" }] },
        }],
      },
    })).toMatchObject({ type: "request.ok" });
    expect(await request(client.socket, client.events, "message.send", { conversationId: conversation.id, content: "And the docs?" }))
      .toMatchObject({ type: "request.result" });
    await client.events.next((event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
      event.type === "snapshot.updated"
      && event.snapshot.conversations.some(({ id, latestTurn }) => id === conversation.id
        && latestTurn?.status === "completed" && latestTurn.id !== settled.snapshot.conversations.find(({ id: chat }) => chat === conversation.id)!.latestTurn!.id));
    const resumed = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method: string;
      params: { threadId?: string; config?: Record<string, unknown> };
    }).filter(({ method }) => method === "thread/start" || method === "thread/resume").at(-1)!;
    expect(resumed.method).toBe("thread/resume");
    expect(resumed.params.threadId).toBe("mcp-runtime-thread");
    expect(resumed.params.config).toEqual({
      "mcp_servers.docs": { url: "https://docs.example.com/mcp", http_headers: { "X-Team": "checkout" } },
    });

    const detail = await loadConversationDetail(client.socket, client.events, conversation.id);
    published.push(JSON.stringify(detail));
    // The answer reached the transcript, with the secret replaced.
    expect(JSON.stringify(detail)).toContain("Used the tracker with [secret].");
    expect(published.length).toBeGreaterThan(10);
    for (const event of published) expect(event).not.toContain(SECRET);
    client.socket.close();
    await runtime.close();
    cleanup.runtimes.splice(cleanup.runtimes.indexOf(runtime), 1);

    // Nothing in the data directory (database, WAL, journals, diagnostics) holds the value.
    const files = filesUnder(data);
    expect(files.some((path) => path.endsWith("inertia.sqlite"))).toBe(true);
    for (const path of files) {
      if (!existsSync(path) || statSync(path).size === 0) continue;
      expect(readFileSync(path).includes(SECRET), path).toBe(false);
      expect(readFileSync(path).includes(Buffer.from(SECRET, "utf16le")), path).toBe(false);
    }
    const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
    try {
      expect(JSON.stringify(store.snapshot())).not.toContain(SECRET);
      expect(JSON.stringify(store.shellSnapshot())).not.toContain(SECRET);
    } finally {
      store.close();
    }
  }, 60_000);
});
