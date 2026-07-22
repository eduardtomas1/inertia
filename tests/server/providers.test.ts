import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { providerEnvironment } from "../../src/server/environment";
import { detectProvider, ProviderManager, type ProviderId } from "../../src/server/providers";

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
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
    await providerEnvironment(true);
  });

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "inertia-provider-"));
    roots.push(root);
    return root;
  }

  function nodeExecutable(root: string, name: string, source: string): string {
    const command = join(root, name);
    writeFileSync(command, `#!${process.execPath}\n${source}\n`);
    chmodSync(command, 0o700);
    return command;
  }

  function codexExecutable(
    root: string,
    name: string,
    options: { version?: string; versionExit?: number; authenticated?: boolean; result?: string; stayAlive?: boolean; appServer?: boolean } = {},
  ): string {
    const version = options.version ?? "1.2.3";
    const versionExit = options.versionExit ?? 0;
    const authenticated = options.authenticated ?? true;
    const result = options.result ?? "A calm result.";
    return nodeExecutable(root, name, `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(${JSON.stringify(`fake-codex ${version}`)});
  process.exit(${versionExit});
}
if (args[0] === "login" && args[1] === "status") {
  ${authenticated ? 'console.log("Logged in using ChatGPT"); process.exit(0);' : 'console.error("Not logged in"); process.exit(1);'}
}
if (args[0] === "app-server" && args[1] === "--help") {
  ${options.appServer === false ? 'console.error("unknown subcommand app-server"); process.exit(2);' : 'console.log("Usage: codex app-server [OPTIONS] - Run the app server"); process.exit(0);'}
}
if (process.env.INERTIA_CAPTURE_PATH) {
  fs.writeFileSync(process.env.INERTIA_CAPTURE_PATH, JSON.stringify({ args, stdin: fs.readFileSync(0, "utf8") }));
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "11111111-1111-4111-8111-111111111111" }));
console.log(JSON.stringify({ type: "turn.started" }));
${options.stayAlive ? "setInterval(() => undefined, 1000);" : `console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(result)} + (process.env.INERTIA_DISCOVERY_MARKER ? ":" + process.env.INERTIA_DISCOVERY_MARKER : "") } }));\nconsole.log(JSON.stringify({ type: "turn.completed" }));`}
`);
  }

  function fakeCodex(): { root: string; command: string } {
    const root = temporaryRoot();
    return { root, command: codexExecutable(root, "fake-codex") };
  }

  it.skipIf(process.platform === "win32")("detects, normalizes, and completes a streamed Codex-style session", async () => {
    const fake = fakeCodex();
    const manager = new ProviderManager({ commands: { codex: fake.command } });
    const detection = await manager.detect("codex", { cwd: fake.root });
    expect(detection).toMatchObject({ available: true, version: "1.2.3", installState: "installed", authState: "authenticated", canRun: true });

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

  it.skipIf(process.platform === "win32")("selects the newest working candidate and reuses its absolute path and discovered environment", async () => {
    const root = temporaryRoot();
    const olderBin = join(root, "older");
    const newerBin = join(root, "newer");
    mkdirSync(olderBin, { recursive: true });
    mkdirSync(newerBin, { recursive: true });
    codexExecutable(olderBin, "codex", { version: "1.9.0", result: "older" });
    const newerCommand = codexExecutable(newerBin, "codex", { version: "2.3.1", result: "newer" });
    const capturePath = join(root, "invocation.json");
    const path = [olderBin, newerBin, "/usr/bin", "/bin"].join(delimiter);
    writeFileSync(join(root, ".zprofile"), `export PATH=${JSON.stringify(path)}\n`);
    writeFileSync(join(root, ".zshrc"), "\n");
    process.env.HOME = root;
    process.env.ZDOTDIR = root;
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = path;
    process.env.INERTIA_CAPTURE_PATH = capturePath;
    process.env.INERTIA_DISCOVERY_MARKER = "from-discovery";

    const manager = new ProviderManager({ commands: { codex: "codex" } });
    const detection = await manager.detect("codex", { cwd: root, refreshEnvironment: true });
    expect(detection).toMatchObject({ available: true, version: "2.3.1", executable: realpathSync(newerCommand), authState: "authenticated" });

    process.env.PATH = "/usr/bin:/bin";
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

    expect(result).toMatchObject({ status: "completed", text: "newer:from-discovery" });
    const invocation = JSON.parse(readFileSync(capturePath, "utf8")) as { args: string[]; stdin: string };
    expect(invocation.args).toEqual([
      "exec", "resume", "--json", "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model", "test-model",
      "--image", join(root, "reference.png"),
      "22222222-2222-4222-8222-222222222222", "-",
    ]);
    expect(invocation.stdin).toBe("Continue carefully");
    await manager.disposeAll();
  });

  it.skipIf(process.platform === "win32")("reports an executable with a failing version probe as an installation error", async () => {
    const root = temporaryRoot();
    const command = codexExecutable(root, "broken-codex", { versionExit: 7 });

    const detection = await detectProvider("codex", { command, cwd: root, refreshEnvironment: true });

    expect(detection).toMatchObject({ available: false, installState: "error", authState: "unknown", canRun: false });
    expect(detection.executable).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("distinguishes authenticated and unauthenticated provider probes", async () => {
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

  it.skipIf(process.platform === "win32")("requires an app-server-compatible Codex CLI", async () => {
    const root = temporaryRoot();
    const command = codexExecutable(root, "old-codex", { authenticated: true, appServer: false });

    await expect(detectProvider("codex", { command, cwd: root })).resolves.toMatchObject({
      installState: "installed",
      authState: "authenticated",
      canRun: false,
      statusMessage: "Update Codex CLI to enable agent conversations",
    });
  });

  it.skipIf(process.platform === "win32")("parses Claude authentication JSON", async () => {
    const connectedRoot = temporaryRoot();
    const signedOutRoot = temporaryRoot();
    const connected = nodeExecutable(connectedRoot, "claude-connected", `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.207 (Claude Code)"); process.exit(0); }
console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
`);
    const signedOut = nodeExecutable(signedOutRoot, "claude-signed-out", `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.207 (Claude Code)"); process.exit(0); }
console.log(JSON.stringify({ loggedIn: false }));
`);

    await expect(detectProvider("claude", { command: connected, cwd: connectedRoot })).resolves.toMatchObject({ authState: "authenticated", canRun: true });
    await expect(detectProvider("claude", { command: signedOut, cwd: signedOutRoot })).resolves.toMatchObject({ authState: "unauthenticated", canRun: false });
  });

  it.skipIf(process.platform === "win32")("normalizes streamed session output from the other provider adapters", async () => {
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
      const command = nodeExecutable(root, `fake-${fixture.providerId}`, fixture.lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("\n"));
      const manager = new ProviderManager({ commands: { [fixture.providerId]: command } });
      const result = await manager.run({ providerId: fixture.providerId, conversationId: `${fixture.providerId}-conversation`, cwd: root, prompt: "Respond", interactionMode: "build", access: "auto-edit" });
      expect(result).toMatchObject({ status: "completed", text: fixture.expectedText, sessionId: fixture.sessionId });
      await manager.disposeAll();
    }
  });

  it.skipIf(process.platform === "win32")("requests real partial messages from Claude without duplicating the final assistant event", async () => {
    const root = temporaryRoot();
    const capturePath = join(root, "claude-invocation.json");
    process.env.INERTIA_CAPTURE_PATH = capturePath;
    const command = nodeExecutable(root, "fake-claude", `
const fs = require("node:fs");
fs.writeFileSync(process.env.INERTIA_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "Partial " } } }));
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "reply" } } }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Partial reply" }] } }));
console.log(JSON.stringify({ type: "result", is_error: false }));
`);
    const manager = new ProviderManager({ commands: { claude: command } });

    const result = await manager.run({ providerId: "claude", conversationId: "claude-partial", cwd: root, prompt: "Respond", interactionMode: "build", access: "auto-edit" });

    expect(result).toMatchObject({ status: "completed", text: "Partial reply" });
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toContain("--include-partial-messages");
    await manager.disposeAll();
  });

  it.skipIf(process.platform === "win32")("classifies authentication failures from provider stderr", async () => {
    const root = temporaryRoot();
    const command = nodeExecutable(root, "failing-codex", `
process.stderr.write("Authentication required. Please log in.\\n");
process.exit(1);
`);
    const manager = new ProviderManager({ commands: { codex: command } });

    const result = await manager.run({ providerId: "codex", conversationId: "failed-conversation", cwd: root, prompt: "Respond", interactionMode: "build", access: "full" });

    expect(result).toMatchObject({ status: "failed", exitCode: 1, error: "Codex is not authenticated. Sign in with its CLI and try again." });
    await manager.disposeAll();
  });

  it.skipIf(process.platform === "win32")("cancels a running provider and settles its run exactly once", async () => {
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
