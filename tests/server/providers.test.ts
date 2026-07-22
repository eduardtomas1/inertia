import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { providerEnvironment } from "../../src/server/environment";
import { AgentHarnessRegistry, detectProvider, ProviderManager, type ProviderId } from "../../src/server/providers";
import { createCliAgentHarness } from "../../src/server/provider/cli-agent-harness";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

const MUTATED_ENVIRONMENT_KEYS = ["HOME", "PATH", "SHELL", "ZDOTDIR", "INERTIA_CAPTURE_PATH", "INERTIA_DISCOVERY_MARKER"] as const;

describe.sequential("provider runtime", () => {
  const roots: string[] = [];
  const originalEnvironment = Object.fromEntries(MUTATED_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

  afterEach(async () => {
    for (const key of MUTATED_ENVIRONMENT_KEYS) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(roots.splice(0).map(removePortableFixture));
    await providerEnvironment(true);
  });

  function temporaryRoot(): string {
    const root = portableFixtureRoot("provider runtime");
    roots.push(root);
    return root;
  }

  function nodeProgram(root: string, name: string, source: string): { command: string; program: string } {
    return {
      command: portableNodeExecutable(root, name),
      program: writeNodeSubcommand(root, `${name}-fixture`, source),
    };
  }

  function codexExecutable(
    root: string,
    name: string,
    options: { authenticated?: boolean; result?: string; stayAlive?: boolean; appServer?: boolean } = {},
    executableDirectory = root,
  ): string {
    const authenticated = options.authenticated ?? true;
    const result = options.result ?? "A calm result.";
    const command = portableNodeExecutable(executableDirectory, name);
    writeNodeSubcommand(root, "login", `
if (${JSON.stringify(authenticated)}) {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
console.error("Not logged in");
process.exit(1);
`);
    writeNodeSubcommand(root, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--help") {
  ${options.appServer === false ? 'console.error("unknown subcommand app-server"); process.exit(2);' : 'console.log("Usage: codex app-server [OPTIONS] - Run the app server"); process.exit(0);'}
}
if (args.length === 0) {
  const messages = [];
  const capture = (message) => {
    if (!process.env.INERTIA_CAPTURE_PATH) return;
    messages.push(message);
    fs.writeFileSync(process.env.INERTIA_CAPTURE_PATH, JSON.stringify({ args: ["app-server", ...args], messages }));
  };
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  let threadId = "11111111-1111-4111-8111-111111111111";
  const turnId = "turn-1";
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    capture(message);
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
      ${options.stayAlive ? "return;" : `const text = ${JSON.stringify(result)} + (process.env.INERTIA_DISCOVERY_MARKER ? ":" + process.env.INERTIA_DISCOVERY_MARKER : "");
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-1", delta: text } });
      return send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });`}
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
`);
    return command;
  }

  function fakeCodex(): { root: string; command: string } {
    const root = temporaryRoot();
    return { root, command: codexExecutable(root, "fake-codex") };
  }

  it("detects, normalizes, and completes a streamed Codex-style session", async () => {
    const fake = fakeCodex();
    const manager = new ProviderManager({ commands: { codex: fake.command } });
    const detection = await manager.detect("codex", { cwd: fake.root });
    expect(detection).toMatchObject({ available: true, version: process.version, installState: "installed", authState: "authenticated", canRun: true });

    const text: string[] = [];
    const sessions: string[] = [];
    const result = await manager.run(
      { providerId: "codex", conversationId: "conversation", cwd: fake.root, prompt: "Do the work", interactionMode: "build", access: "full" },
      { onText: (event) => text.push(event.text), onSession: (event) => sessions.push(event.sessionId) },
    );
    expect(result).toMatchObject({ status: "completed", text: "A calm result.", sessionId: "11111111-1111-4111-8111-111111111111" });
    expect(text).toEqual(["A calm result."]);
    expect(sessions).toEqual(["11111111-1111-4111-8111-111111111111"]);
    await manager.disposeAll();
  });

  it("selects the newest working candidate from a multi-install probe", async () => {
    const root = temporaryRoot();
    const older = join(root, "older provider", "codex");
    const newer = join(root, "newer provider", "codex");
    const detection = await detectProvider("codex", { command: "codex", cwd: root }, {
      executableCandidates: async () => [older, newer],
      probeProcess: async (executable, args) => ({
        started: true,
        timedOut: false,
        exitCode: 0,
        output: args[0] === "--version"
          ? `codex ${executable === newer ? "2.3.1" : "1.9.0"}`
          : args[0] === "login"
            ? "Logged in using ChatGPT"
            : "codex app-server - Run the app server",
      }),
    });

    expect(detection).toMatchObject({
      available: true,
      executable: newer,
      version: "2.3.1",
      authState: "authenticated",
      canRun: true,
    });
  });

  it("resolves and reuses an absolute command path and its discovered environment", async () => {
    const root = temporaryRoot();
    const selectedBin = join(root, "selected provider bin");
    mkdirSync(selectedBin, { recursive: true });
    const selectedCommand = codexExecutable(root, "codex", { result: "selected" }, selectedBin);
    const capturePath = join(root, "invocation.json");
    const path = [selectedBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
    process.env.HOME = root;
    process.env.ZDOTDIR = root;
    process.env.PATH = path;
    process.env.INERTIA_CAPTURE_PATH = capturePath;
    process.env.INERTIA_DISCOVERY_MARKER = "from-discovery";

    const manager = new ProviderManager({ commands: { codex: "codex" } });
    const detection = await manager.detect("codex", { cwd: root, refreshEnvironment: true });
    expect(detection).toMatchObject({ available: true, version: process.version, executable: realpathSync.native(selectedCommand), authState: "authenticated" });

    process.env.PATH = root;
    process.env.INERTIA_DISCOVERY_MARKER = "after-discovery";
    const result = await manager.run({
      providerId: "codex",
      conversationId: "resume-conversation",
      cwd: root,
      prompt: "Continue carefully",
      interactionMode: "build",
      access: "full",
      sessionId: "22222222-2222-4222-8222-222222222222",
      model: "test-model",
      imagePaths: [join(root, "reference.png")],
    });

    expect(result).toMatchObject({ status: "completed", text: "selected:from-discovery" });
    const invocation = JSON.parse(readFileSync(capturePath, "utf8")) as { args: string[]; messages: Array<Record<string, unknown>> };
    expect(invocation.args).toEqual(["app-server"]);
    expect(invocation.messages.find(({ method }) => method === "thread/resume")).toMatchObject({
      params: {
        threadId: "22222222-2222-4222-8222-222222222222",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        model: "test-model",
      },
    });
    expect(invocation.messages.find(({ method }) => method === "turn/start")).toMatchObject({
      params: {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        model: "test-model",
        input: [
          { type: "text", text: "Continue carefully", text_elements: [] },
          { type: "localImage", path: join(root, "reference.png") },
        ],
      },
    });
    await manager.disposeAll();
  });

  it("reports a missing executable without attempting provider authentication", async () => {
    const root = temporaryRoot();
    const command = join(root, process.platform === "win32" ? "missing-codex.exe" : "missing-codex");

    const detection = await detectProvider("codex", { command, cwd: root, refreshEnvironment: true });

    expect(detection).toMatchObject({ available: false, installState: "not-installed", authState: "unknown", canRun: false });
    expect(detection.executable).toBeUndefined();
  });

  it("reports a candidate with a failing version probe as an installation error", async () => {
    const root = temporaryRoot();
    const command = portableNodeExecutable(root, "broken-codex");
    const detection = await detectProvider("codex", { command, cwd: root }, {
      probeProcess: async () => ({ started: true, timedOut: false, exitCode: 7, output: "version probe failed" }),
    });

    expect(detection).toMatchObject({ available: false, installState: "error", authState: "unknown", canRun: false });
  });

  it("distinguishes authenticated and unauthenticated provider probes", async () => {
    const authenticatedRoot = temporaryRoot();
    const unauthenticatedRoot = temporaryRoot();
    const authenticated = codexExecutable(authenticatedRoot, "connected-codex", { authenticated: true });
    const unauthenticated = codexExecutable(unauthenticatedRoot, "signed-out-codex", { authenticated: false });

    const [connected, signedOut] = await Promise.all([
      detectProvider("codex", { command: authenticated, cwd: authenticatedRoot }),
      detectProvider("codex", { command: unauthenticated, cwd: unauthenticatedRoot }),
    ]);

    expect(connected).toMatchObject({ installState: "installed", authState: "authenticated", canRun: true, statusMessage: "Connected" });
    expect(signedOut).toMatchObject({ installState: "installed", authState: "unauthenticated", canRun: false, statusMessage: "Sign in required" });
  });

  it("requires an app-server-compatible Codex CLI", async () => {
    const root = temporaryRoot();
    const command = codexExecutable(root, "old-codex", { authenticated: true, appServer: false });

    await expect(detectProvider("codex", { command, cwd: root })).resolves.toMatchObject({
      installState: "installed",
      authState: "authenticated",
      canRun: false,
      statusMessage: "Update Codex CLI to enable agent conversations",
    });
  });

  it("parses Claude authentication JSON", async () => {
    const connectedRoot = temporaryRoot();
    const signedOutRoot = temporaryRoot();
    const connected = portableNodeExecutable(connectedRoot, "claude-connected");
    const signedOut = portableNodeExecutable(signedOutRoot, "claude-signed-out");
    writeNodeSubcommand(connectedRoot, "auth", `console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));`);
    writeNodeSubcommand(signedOutRoot, "auth", `console.log(JSON.stringify({ loggedIn: false }));`);

    await expect(detectProvider("claude", { command: connected, cwd: connectedRoot })).resolves.toMatchObject({ authState: "authenticated", canRun: true });
    await expect(detectProvider("claude", { command: signedOut, cwd: signedOutRoot })).resolves.toMatchObject({ authState: "unauthenticated", canRun: false });
  });

  it("accepts Cursor only after the executable advertises ACP", async () => {
    const readyRoot = temporaryRoot();
    const wrongRoot = temporaryRoot();
    const ready = portableNodeExecutable(readyRoot, "agent");
    const wrong = portableNodeExecutable(wrongRoot, "agent");
    writeNodeSubcommand(readyRoot, "acp", `console.log("Cursor Agent Client Protocol (ACP)");`);
    writeNodeSubcommand(readyRoot, "status", `console.log("Logged in");`);
    writeNodeSubcommand(wrongRoot, "acp", `console.error("unknown command"); process.exit(2);`);

    await expect(detectProvider("cursor", { command: ready, cwd: readyRoot })).resolves.toMatchObject({
      available: true,
      installState: "installed",
      authState: "authenticated",
      canRun: true,
    });
    await expect(detectProvider("cursor", { command: wrong, cwd: wrongRoot })).resolves.toMatchObject({
      available: true,
      installState: "installed",
      authState: "unknown",
      canRun: false,
      statusMessage: "Cursor CLI found, but ACP is unavailable",
    });
  });

  it("normalizes streamed session output from the other provider adapters", async () => {
    const fixtures: Array<{ providerId: ProviderId; lines: unknown[]; expectedText: string; sessionId: string }> = [
      {
        providerId: "claude",
        sessionId: "33333333-3333-4333-8333-333333333333",
        expectedText: "Claude response",
        lines: [
          { type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" },
          { type: "stream_event", event: { type: "content_block_delta", delta: { text: "Claude " } } },
          { type: "stream_event", event: { type: "content_block_delta", delta: { text: "response" } } },
          { type: "assistant", message: { content: [{ type: "text", text: "Claude response" }] } },
          { type: "result", is_error: false },
        ],
      },
      {
        providerId: "cursor",
        sessionId: "44444444-4444-4444-8444-444444444444",
        expectedText: "Cursor response",
        lines: [
          { type: "system", subtype: "init", session_id: "44444444-4444-4444-8444-444444444444" },
          { type: "assistant", message: { content: [{ type: "text", text: "Cursor response" }] } },
          { type: "result", is_error: false },
        ],
      },
      {
        providerId: "opencode",
        sessionId: "55555555-5555-4555-8555-555555555555",
        expectedText: "OpenCode response",
        lines: [
          { type: "step_start", part: { sessionID: "55555555-5555-4555-8555-555555555555" } },
          { type: "text", part: { text: "OpenCode response" } },
          { type: "step_finish", part: { reason: "stop" } },
        ],
      },
    ];

    for (const fixture of fixtures) {
      const root = temporaryRoot();
      const { command, program } = nodeProgram(root, `fake-${fixture.providerId}`, fixture.lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("\n"));
      const manager = new ProviderManager(
        { commands: { [fixture.providerId]: command } },
        new AgentHarnessRegistry([createCliAgentHarness(fixture.providerId, { prefixArgs: [program] })]),
      );
      const result = await manager.run({ providerId: fixture.providerId, conversationId: `${fixture.providerId}-conversation`, cwd: root, prompt: "Respond", interactionMode: "build", access: "auto-edit" });
      expect(result).toMatchObject({ status: "completed", text: fixture.expectedText, sessionId: fixture.sessionId });
      await manager.disposeAll();
    }
  });

  it("requests real partial messages from Claude without duplicating the final assistant event", async () => {
    const root = temporaryRoot();
    const capturePath = join(root, "claude-invocation.json");
    process.env.INERTIA_CAPTURE_PATH = capturePath;
    const { command, program } = nodeProgram(root, "fake-claude", `
const fs = require("node:fs");
fs.writeFileSync(process.env.INERTIA_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "Partial " } } }));
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "reply" } } }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Partial reply" }] } }));
console.log(JSON.stringify({ type: "result", is_error: false }));
`);
    const manager = new ProviderManager(
      { commands: { claude: command } },
      new AgentHarnessRegistry([createCliAgentHarness("claude", { prefixArgs: [program] })]),
    );

    const result = await manager.run({ providerId: "claude", conversationId: "claude-partial", cwd: root, prompt: "Respond", interactionMode: "build", access: "auto-edit" });

    expect(result).toMatchObject({ status: "completed", text: "Partial reply" });
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toContain("--include-partial-messages");
    await manager.disposeAll();
  });

  it("classifies authentication failures from provider stderr", async () => {
    const root = temporaryRoot();
    const { command, program } = nodeProgram(root, "failing-codex", `
process.stderr.write("Authentication required. Please log in.\\n");
process.exit(1);
`);
    const manager = new ProviderManager(
      { commands: { codex: command } },
      new AgentHarnessRegistry([createCliAgentHarness("codex", { prefixArgs: [program] })]),
    );

    const result = await manager.run({ providerId: "codex", conversationId: "failed-conversation", cwd: root, prompt: "Respond", interactionMode: "build", access: "full" });

    expect(result).toMatchObject({ status: "failed", exitCode: 1, error: "Codex is not authenticated. Sign in with its CLI and try again." });
    await manager.disposeAll();
  });

  it("cancels a running provider and settles its run exactly once", async () => {
    const root = temporaryRoot();
    const command = codexExecutable(root, "waiting-codex", { stayAlive: true });
    const manager = new ProviderManager({ commands: { codex: command }, cancelGraceMs: 100 });
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const statuses: string[] = [];
    const run = manager.run(
      { providerId: "codex", conversationId: "cancel-conversation", cwd: root, prompt: "Wait", interactionMode: "build", access: "full" },
      { onStatus: ({ status }) => { statuses.push(status); if (status === "running") markRunning(); } },
    );
    await running;

    expect(manager.cancel("cancel-conversation")).toBe(true);
    expect(manager.cancel("cancel-conversation")).toBe(false);
    await expect(run).resolves.toMatchObject({ status: "cancelled" });
    expect(statuses).toEqual(["starting", "running", "cancelling", "cancelled"]);
    expect(manager.activeConversationIds()).toEqual([]);
    await manager.disposeAll();
  });
});
