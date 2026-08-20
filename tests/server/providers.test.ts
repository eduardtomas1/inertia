import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { providerEnvironment } from "../../src/server/environment";
import { AgentHarnessRegistry, detectProvider, ProviderManager } from "../../src/server/providers";
import { providerFailureMessage } from "../../src/server/provider/adapters";
import { createCliAgentHarness } from "../../src/server/provider/cli-agent-harness";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const MUTATED_ENVIRONMENT_KEYS = [
  "CODEX_HOME",
  "CODEX_INSTALL_DIR",
  "HOME",
  "OPENAI_API_KEY",
  "PATH",
  "SHELL",
  "ZDOTDIR",
] as const;

describe.sequential("provider runtime", () => {
  const roots: string[] = [];
  const descendantPids: number[] = [];
  const originalEnvironment = Object.fromEntries(MUTATED_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

  afterEach(async () => {
    for (const pid of descendantPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process-tree cleanup under test may already have removed it.
      }
    }
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

  function nodeCommand(root: string, name: string, source: string): string {
    const program = writeNodeSubcommand(root, `${name}.cjs`, source);
    if (process.platform === "win32") {
      const command = join(root, `${name}.cmd`);
      writeFileSync(
        command,
        `@"${process.execPath}" "${program}" %*\r\n`,
        "utf8",
      );
      return command;
    }
    const command = join(root, name);
    const shellLiteral = (value: string): string =>
      `'${value.replaceAll("'", "'\"'\"'")}'`;
    writeFileSync(
      command,
      `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(program)} "$@"\n`,
      "utf8",
    );
    chmodSync(command, 0o700);
    return command;
  }

  function processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
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
    if (!process.env.HOME) return;
    messages.push(message);
    fs.writeFileSync(
      require("node:path").join(process.env.HOME, "invocation.json"),
      JSON.stringify({ args: ["app-server", ...args], messages }),
    );
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
      ${options.stayAlive ? "return;" : `const text = ${JSON.stringify(result)} + (process.env.CODEX_HOME ? ":" + process.env.CODEX_HOME : "");
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
      nativeProviderRunInput({ providerId: "codex", conversationId: "conversation", cwd: fake.root, prompt: "Do the work", interactionMode: "build", access: "full" }),
      { onText: (event) => text.push(event.text), onSession: (event) => sessions.push(event.sessionId) },
    );
    expect(result).toMatchObject({ status: "completed", text: "A calm result.", sessionId: "11111111-1111-4111-8111-111111111111" });
    expect(text).toEqual(["A calm result."]);
    expect(sessions).toEqual(["11111111-1111-4111-8111-111111111111"]);
    await manager.disposeAll();
  });

  it("expands CODEX_HOME before launching a shell-free Codex App Server", async () => {
    const fake = fakeCodex();
    process.env.CODEX_HOME = "~/.codex-work";
    const manager = new ProviderManager({ commands: { codex: fake.command } });

    const result = await manager.run(
      nativeProviderRunInput({
        providerId: "codex",
        conversationId: "conversation-home-shorthand",
        cwd: fake.root,
        prompt: "Read the home path",
        interactionMode: "build",
        access: "full",
      }),
    );

    expect(result).toMatchObject({
      status: "completed",
      text: `A calm result.:${join(homedir(), ".codex-work")}`,
    });
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
        cleanupConfirmed: true,
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

  it("checks installation readiness without probing or forwarding authentication", async () => {
    const root = temporaryRoot();
    const executable = join(root, "codex");
    const probes: string[][] = [];
    process.env.OPENAI_API_KEY = "must-not-reach-readiness-probe";
    process.env.CODEX_HOME = join(root, "custom-codex-home");
    process.env.CODEX_INSTALL_DIR = join(root, "custom-codex-install");

    const detection = await detectProvider("codex", {
      command: "codex",
      cwd: root,
      probeAuthentication: false,
      refreshEnvironment: true,
    }, {
      executableCandidates: async (_command, environment) => {
        expect(environment.env).toMatchObject({
          CODEX_HOME: process.env.CODEX_HOME,
          CODEX_INSTALL_DIR: process.env.CODEX_INSTALL_DIR,
        });
        expect(environment.env).not.toHaveProperty("OPENAI_API_KEY");
        return [executable];
      },
      probeProcess: async (_executable, args, environment) => {
        probes.push([...args]);
        expect(environment.env).not.toHaveProperty("OPENAI_API_KEY");
        expect(environment.env).not.toHaveProperty("HOME");
        expect(environment.env).not.toHaveProperty("HTTPS_PROXY");
        expect(environment.env).not.toHaveProperty("CODEX_HOME");
        expect(environment.env).not.toHaveProperty("CODEX_INSTALL_DIR");
        return {
          started: true,
          timedOut: false,
          exitCode: 0,
          output: args[0] === "--version"
            ? "codex 2.3.1"
            : "codex app-server - Run the app server",
          cleanupConfirmed: true,
        };
      },
    });

    expect(probes).toEqual([
      ["--version"],
      ["app-server", "--help"],
    ]);
    expect(detection).toMatchObject({
      available: true,
      version: "2.3.1",
      installState: "installed",
      authState: "unknown",
      canRun: false,
      statusMessage: "Codex is installed; authentication was not checked",
    });
  });

  it("uses the newest App Server-capable Codex candidate and prefers a native executable at the same version", async () => {
    const root = temporaryRoot();
    const oldCompatible = join(root, "codex-old.exe");
    const newUnsupported = join(root, "codex-new.cmd");
    const nativeTie = join(root, "codex-native.exe");
    const shimTie = join(root, "codex-shim.cmd");
    const probes = async (executable: string, args: readonly string[]) => ({
      started: true,
      timedOut: false,
      exitCode: args[0] === "app-server" && executable === newUnsupported ? 2 : 0,
      output: args[0] === "--version"
        ? `codex ${executable === oldCompatible ? "2.0.0" : executable === newUnsupported ? "3.0.0" : "4.0.0"}`
        : args[0] === "login"
          ? "Logged in using ChatGPT"
          : executable === newUnsupported ? "unknown subcommand" : "codex app-server",
      cleanupConfirmed: true,
    });

    const compatibleFallback = await detectProvider("codex", { command: "codex", cwd: root }, {
      executableCandidates: async () => [oldCompatible, newUnsupported],
      probeProcess: probes,
    });
    expect(compatibleFallback).toMatchObject({ executable: oldCompatible, version: "2.0.0", canRun: true });

    const nativePreference = await detectProvider("codex", { command: "codex", cwd: root }, {
      executableCandidates: async () => [shimTie, nativeTie],
      probeProcess: probes,
    });
    expect(nativePreference).toMatchObject({ executable: nativeTie, version: "4.0.0", canRun: true });
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
    process.env.CODEX_HOME = "from-discovery";

    const manager = new ProviderManager({ commands: { codex: "codex" } });
    const detection = await manager.detect("codex", { cwd: root, refreshEnvironment: true });
    expect(detection).toMatchObject({ available: true, version: process.version, executable: realpathSync.native(selectedCommand), authState: "authenticated" });

    process.env.PATH = root;
    process.env.CODEX_HOME = "after-discovery";
    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "resume-conversation",
      cwd: root,
      prompt: "Continue carefully",
      interactionMode: "build",
      access: "full",
      sessionId: "22222222-2222-4222-8222-222222222222",
      model: "test-model",
      imagePaths: [join(root, "reference.png")],
    }));

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
    expect(detection.statusMessage).toBe("Codex CLI not found");
  });

  it("removes descendants from a timed-out provider discovery probe", async () => {
    const root = temporaryRoot();
    const childPidPath = join(root, "discovery-child.pid");
    // Starting a copied Node executable can exceed the production discovery
    // deadline on a contended Windows runner. This test proves descendant
    // cleanup, not startup latency, so leave enough time for the fixture to
    // establish the descendant whose ownership is being asserted.
    const probeTimeoutMs = process.platform === "win32" ? 5_000 : 250;
    const descendantExecutable = portableNodeExecutable(
      root,
      "discovery-descendant",
    );
    const command = nodeCommand(root, "hanging-codex", `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const descendant = spawn(
  ${JSON.stringify(descendantExecutable)},
  ["-e", "setInterval(() => {}, 1000)"],
  { stdio: "ignore" },
);
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(descendant.pid));
setInterval(() => {}, 1000);
`);

    await expect(detectProvider("codex", {
      command,
      cwd: root,
      refreshEnvironment: true,
      timeoutMs: probeTimeoutMs,
    })).resolves.toMatchObject({
      available: false,
      installState: "error",
      canRun: false,
    });

    let descendantPid = 0;
    await waitFor("the discovery descendant PID to be recorded", () => {
      try {
        descendantPid = Number(readFileSync(childPidPath, "utf8"));
        return Number.isSafeInteger(descendantPid) && descendantPid > 0;
      } catch {
        return false;
      }
    });
    expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
    if (process.platform === "win32") {
      // A stopped Windows PID can be recycled by another Vitest worker before
      // this assertion runs. The owned executable remains a stable identity:
      // Windows cannot delete it until the original descendant releases it.
      descendantPids.push(descendantPid);
      await waitFor("the discovery descendant executable to be released", () => {
        try {
          rmSync(descendantExecutable);
          return true;
        } catch {
          return false;
        }
      });
      // Executable release proves the owned process is gone, so do not retain
      // its now-recyclable PID for afterEach. If the assertion throws first,
      // the PID remains registered for best-effort failure-path cleanup.
      descendantPids.pop();
    } else {
      descendantPids.push(descendantPid);
      await waitFor(
        "the discovery descendant to stop",
        () => !processExists(descendantPid),
      );
    }
  });

  it("reports an unconfirmed timed-out discovery cleanup instead of readiness", async () => {
    const root = temporaryRoot();
    const command = nodeCommand(
      root,
      "unconfirmed-codex",
      "setInterval(() => {}, 1000);",
    );

    await expect(detectProvider("codex", {
      command,
      cwd: root,
      refreshEnvironment: true,
      timeoutMs: 250,
    }, {
      terminateProcessTree: async (child, force) => {
        await terminateProcessTreeAndWait(child, force);
        return false;
      },
    })).resolves.toMatchObject({
      available: false,
      installState: "error",
      canRun: false,
      statusMessage: "Codex probe timed out, and its process tree could not be confirmed stopped",
    });
  });

  it("does not report readiness after unconfirmed auth-probe cleanup", async () => {
    const root = temporaryRoot();
    const command = join(root, "codex");

    await expect(detectProvider("codex", { command, cwd: root }, {
      executableCandidates: async () => [command],
      probeProcess: async (_executable, args) => args[0] === "login"
        ? {
            started: true,
            timedOut: true,
            exitCode: null,
            output: "",
            cleanupConfirmed: false,
          }
        : {
            started: true,
            timedOut: false,
            exitCode: 0,
            output: args[0] === "--version"
              ? "codex 1.2.3"
              : "codex app-server - Run the app server",
            cleanupConfirmed: true,
          },
    })).resolves.toMatchObject({
      available: true,
      installState: "installed",
      canRun: false,
      statusMessage: "Codex connection probe timed out, and its process tree could not be confirmed stopped",
    });
  });

  it("blocks admission when any discovered candidate has unconfirmed cleanup", async () => {
    const root = temporaryRoot();
    const unconfirmed = join(root, "old-codex");
    const selected = join(root, "new-codex");

    await expect(detectProvider("codex", { cwd: root }, {
      executableCandidates: async () => [unconfirmed, selected],
      probeProcess: async (executable, args) => {
        if (executable === unconfirmed) {
          return {
            started: true,
            timedOut: true,
            exitCode: null,
            output: "",
            cleanupConfirmed: false,
          };
        }
        return {
          started: true,
          timedOut: false,
          exitCode: 0,
          output: args[0] === "--version"
            ? "codex 2.0.0"
            : args[0] === "app-server"
            ? "codex app-server - Run the app server"
            : "Logged in using ChatGPT",
          cleanupConfirmed: true,
        };
      },
    })).resolves.toMatchObject({
      available: true,
      canRun: false,
      cleanupConfirmed: false,
      statusMessage: "Codex probe cleanup could not be confirmed stopped",
    });
  });

  it("reports a candidate with a failing version probe as an installation error", async () => {
    const root = temporaryRoot();
    const command = portableNodeExecutable(root, "broken-codex");
    const detection = await detectProvider("codex", { command, cwd: root }, {
      probeProcess: async () => ({
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
        exitCode: 7,
        output: "version probe failed",
      }),
    });

    expect(detection).toMatchObject({ available: false, installState: "error", authState: "unknown", canRun: false });
    expect(detection.statusMessage).toBe("Codex CLI was found but failed to start");
  });

  it("distinguishes authenticated and unauthenticated provider probes", async () => {
    const authenticatedRoot = temporaryRoot();
    const unauthenticatedRoot = temporaryRoot();
    const authenticated = codexExecutable(authenticatedRoot, "connected-codex", { authenticated: true });
    const unauthenticated = codexExecutable(unauthenticatedRoot, "signed-out-codex", { authenticated: false });

    // Probe the freshly copied Windows executables independently. Running
    // both copies at once can race host scanning and turn a valid fixture
    // into an unrelated launch error.
    const connected = await detectProvider("codex", {
      command: authenticated,
      cwd: authenticatedRoot,
    });
    const signedOut = await detectProvider("codex", {
      command: unauthenticated,
      cwd: unauthenticatedRoot,
    });

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
      statusMessage: "Codex App Server is unsupported; update the selected CLI",
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

  it("does not treat OpenCode's successful zero-credential listing as runnable", async () => {
    const executable = join(temporaryRoot(), "opencode");
    await expect(detectProvider("opencode", { command: executable }, {
      executableCandidates: async () => [executable],
      probeProcess: async (_candidate, args) => ({
        exitCode: 0,
        output: args[0] === "--version" ? "opencode 1.18.10" : "Credentials\n0 credentials",
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
      }),
    })).resolves.toMatchObject({
      available: true,
      installState: "installed",
      authState: "unknown",
      canRun: false,
      statusMessage: "Installed; connection not confirmed",
    });
  });

  it("recognizes OpenCode credentials supplied through its active environment", async () => {
    const executable = join(temporaryRoot(), "opencode");
    await expect(detectProvider("opencode", { command: executable }, {
      executableCandidates: async () => [executable],
      probeProcess: async (_candidate, args) => ({
        exitCode: 0,
        output: args[0] === "--version"
          ? "opencode 1.18.10"
          : "Credentials\n0 credentials\nEnvironment\n1 environment variable",
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
      }),
    })).resolves.toMatchObject({ authState: "configured", canRun: true, statusMessage: "Configured" });
  });

  it("admits an OAuth-only Kimi install for authoritative ACP authentication", async () => {
    const executable = join(temporaryRoot(), "kimi");
    const probes: string[][] = [];
    await expect(detectProvider("kimi", { command: executable }, {
      executableCandidates: async () => [executable],
      probeProcess: async (_candidate, args) => {
        probes.push([...args]);
        return {
          exitCode: 0,
          output: args[0] === "--version"
            ? "kimi 0.36.1"
            : args[0] === "acp"
              ? "Run Kimi Code as an Agent Client Protocol (ACP) server"
              : JSON.stringify({ providers: {} }),
          started: true,
          timedOut: false,
          cleanupConfirmed: true,
        };
      },
    })).resolves.toMatchObject({
      available: true,
      installState: "installed",
      authState: "unknown",
      canRun: true,
      statusMessage: "Installed; Kimi ACP will verify sign-in when a session starts",
    });
    expect(probes).toEqual([
      ["--version"],
      ["acp", "--help"],
      ["provider", "list", "--json"],
    ]);
  });

  it("blocks Kimi when its credential probe explicitly requires login", async () => {
    const executable = join(temporaryRoot(), "kimi");
    await expect(detectProvider("kimi", { command: executable }, {
      executableCandidates: async () => [executable],
      probeProcess: async (_candidate, args) => ({
        exitCode: args[0] === "provider" ? 1 : 0,
        output: args[0] === "--version"
          ? "kimi 0.36.1"
          : args[0] === "acp"
            ? "Run Kimi Code as an Agent Client Protocol (ACP) server"
            : "Authentication required; please log in.",
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
      }),
    })).resolves.toMatchObject({
      available: true,
      installState: "installed",
      authState: "unauthenticated",
      canRun: false,
      statusMessage: "Sign in required",
    });
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

  it("prefers the Cursor-specific executable and rejects an unrelated generic ACP agent", async () => {
    const root = temporaryRoot();
    const cursorAgent = join(root, "cursor-agent");
    const genericAgent = join(root, "agent");
    const candidates = new Map([
      ["cursor-agent", [cursorAgent]],
      ["agent", [genericAgent]],
    ]);
    const probeProcess = async (executable: string, args: readonly string[]) => ({
      started: true,
      timedOut: false,
      exitCode: 0,
      output: args[0] === "--version"
        ? executable === genericAgent ? "generic-agent 99.0.0" : "cursor-agent 1.0.0"
        : args[0] === "status"
          ? "Logged in"
          : executable === genericAgent ? "Agent Client Protocol (ACP)" : "Cursor Agent Client Protocol (ACP)",
      cleanupConfirmed: true,
    });

    await expect(detectProvider("cursor", { cwd: root }, {
      executableCandidates: async (command) => candidates.get(command) ?? [],
      probeProcess,
    })).resolves.toMatchObject({
      available: true,
      executable: cursorAgent,
      version: "1.0.0",
      canRun: true,
    });

    await expect(detectProvider("cursor", {
      command: genericAgent,
      cwd: root,
    }, {
      executableCandidates: async () => [genericAgent],
      probeProcess,
    })).resolves.toMatchObject({
      available: true,
      installState: "installed",
      canRun: false,
      statusMessage: "Cursor CLI found, but ACP is unavailable",
    });
  });

  it("probes a configured Cursor editor launcher through its agent subcommand", async () => {
    const root = temporaryRoot();
    const editor = join(root, "cursor");
    const probes: string[][] = [];

    await expect(detectProvider("cursor", {
      command: editor,
      cwd: root,
    }, {
      executableCandidates: async () => [editor],
      probeProcess: async (_executable, args) => {
        probes.push([...args]);
        return {
          started: true,
          timedOut: false,
          exitCode: 0,
          output: args[0] === "--version"
            ? "Cursor 2.0.0"
            : args.at(-1) === "status"
              ? "Logged in"
              : "Cursor Agent Client Protocol (ACP)",
          cleanupConfirmed: true,
        };
      },
    })).resolves.toMatchObject({
      available: true,
      executable: editor,
      canRun: true,
    });
    expect(probes).toEqual([
      ["--version"],
      ["agent", "acp", "--help"],
      ["agent", "status"],
    ]);
  });

  it("normalizes streamed session output from the legacy CLI provider adapters", async () => {
    type LegacyCliProviderId = "claude" | "cursor" | "opencode";
    const fixtures: Array<{
      providerId: LegacyCliProviderId;
      lines: unknown[];
      expectedText: string;
      sessionId: string;
    }> = [
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
      const { command, program } = nodeProgram(root, `fake-${fixture.providerId}`, `${fixture.lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("\n")}
setInterval(() => {}, 1000);
`);
      const manager = new ProviderManager(
        { commands: { [fixture.providerId]: command } },
        new AgentHarnessRegistry([createCliAgentHarness(fixture.providerId, { prefixArgs: [program] })]),
      );
      try {
        const result = await manager.run(nativeProviderRunInput({ providerId: fixture.providerId, harnessId: `${fixture.providerId}-cli`, conversationId: `${fixture.providerId}-conversation`, cwd: root, prompt: "Respond", interactionMode: "build", access: "auto-edit" }));
        expect(result).toMatchObject({ status: "completed", text: fixture.expectedText, sessionId: fixture.sessionId, cleanupConfirmed: true });
        expect(manager.isRunning(`${fixture.providerId}-conversation`)).toBe(false);
      } finally {
        await manager.disposeAll();
      }
    }
  });

  it("arms complete-tree cleanup before an ordinary CLI terminal result", async () => {
    const root = temporaryRoot();
    const { command, program } = nodeProgram(root, "successful-codex-cli", `
console.log(JSON.stringify({ type: "turn.started", thread_id: "cli-session" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "CLI response" } }));
console.log(JSON.stringify({ type: "turn.completed" }));
`);
    const terminateProcessTree = vi.fn(async () => true);
    const manager = new ProviderManager(
      { commands: { codex: command } },
      new AgentHarnessRegistry([
        createCliAgentHarness("codex", {
          prefixArgs: [program],
          terminateProcessTree,
        }),
      ]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "codex",
      harnessId: "codex-cli",
      conversationId: "successful-cli",
      cwd: root,
      prompt: "Respond",
      interactionMode: "build",
      access: "full",
    }))).resolves.toMatchObject({
      status: "completed",
      text: "CLI response",
      sessionId: "cli-session",
    });
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(terminateProcessTree).toHaveBeenCalledWith(expect.anything(), true);
    await manager.disposeAll();
  });

  it("acknowledges provider start only after async backend resolution reaches the harness", async () => {
    const root = temporaryRoot();
    const { command, program } = nodeProgram(root, "acknowledged-codex-cli", `
console.log(JSON.stringify({ type: "turn.completed" }));
setInterval(() => {}, 1000);
`);
    let releaseBackend!: (environment: NodeJS.ProcessEnv) => void;
    const backend = new Promise<NodeJS.ProcessEnv>((resolve) => {
      releaseBackend = resolve;
    });
    const manager = new ProviderManager(
      {
        commands: { codex: command },
        resolveBackendLaunchOptions: async (_input, environment) => ({
          environment: await backend.then(() => environment),
        }),
      },
      new AgentHarnessRegistry([
        createCliAgentHarness("codex", { prefixArgs: [program] }),
      ]),
    );
    let acknowledgeStart!: () => void;
    const started = new Promise<void>((resolve) => {
      acknowledgeStart = resolve;
    });
    const onStarted = vi.fn(acknowledgeStart);
    try {
      const result = manager.run(nativeProviderRunInput({
        providerId: "codex",
        harnessId: "codex-cli",
        conversationId: "acknowledged-cli",
        cwd: root,
        prompt: "Respond",
        interactionMode: "build",
        access: "full",
      }), { onStarted });
      await Promise.resolve();
      expect(onStarted).not.toHaveBeenCalled();

      releaseBackend({});
      await started;
      expect(onStarted).toHaveBeenCalledTimes(1);
      await expect(result).resolves.toMatchObject({
        status: "completed",
        cleanupConfirmed: true,
      });
      expect(manager.isRunning("acknowledged-cli")).toBe(false);
    } finally {
      await manager.disposeAll();
    }
  });

  it("does not acknowledge an async backend rejection before harness start", async () => {
    const root = temporaryRoot();
    const onStarted = vi.fn();
    const manager = new ProviderManager(
      {
        commands: { codex: "codex" },
        resolveBackendLaunchOptions: async () => {
          await Promise.resolve();
          throw new Error("credential resolution rejected");
        },
      },
      new AgentHarnessRegistry([createCliAgentHarness("codex")]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "codex",
      harnessId: "codex-cli",
      conversationId: "rejected-before-start",
      cwd: root,
      prompt: "Respond",
      interactionMode: "build",
      access: "full",
    }), { onStarted })).rejects.toThrow(/credential resolution rejected/u);
    expect(onStarted).not.toHaveBeenCalled();
    expect(manager.isRunning("rejected-before-start")).toBe(false);
    await manager.disposeAll();
  });

  it("maps unconfirmed CLI cancellation cleanup to one failed terminal result", async () => {
    const root = temporaryRoot();
    const { command, program } = nodeProgram(root, "stalled-codex-cli", `
console.log(JSON.stringify({ type: "turn.started", thread_id: "cli-session" }));
setInterval(() => {}, 1000);
`);
    const terminateProcessTree = vi.fn(async (child, _force: boolean) => {
      await terminateProcessTreeAndWait(child, true);
      return false;
    });
    const manager = new ProviderManager(
      { commands: { codex: command } },
      new AgentHarnessRegistry([
        createCliAgentHarness("codex", {
          prefixArgs: [program],
          terminateProcessTree,
        }),
      ]),
    );
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const statuses: string[] = [];
    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      harnessId: "codex-cli",
      conversationId: "failed-cli-cleanup",
      cwd: root,
      prompt: "Wait",
      interactionMode: "build",
      access: "full",
    }), {
      onStatus: ({ status }) => {
        statuses.push(status);
        if (status === "running") markRunning();
      },
    });

    await running;
    expect(manager.cancel("failed-cli-cleanup")).toBe(true);

    await expect(result).resolves.toMatchObject({
      status: "failed",
      error: "Codex CLI process tree could not be confirmed stopped.",
    });
    expect(statuses).not.toContain("cancelled");
    expect(statuses.at(-1)).toBe("failed");
    expect(terminateProcessTree.mock.calls.map(([, force]) => force)).toEqual([
      false,
      true,
    ]);
    expect(manager.isRunning("failed-cli-cleanup")).toBe(true);
    await expect(manager.disposeAll()).rejects.toThrow(
      "Provider process cleanup could not be confirmed.",
    );
  });

  it("requests real partial messages from Claude without duplicating the final assistant event", async () => {
    const root = temporaryRoot();
    const capturePath = join(root, "claude-invocation.json");
    const { command, program } = nodeProgram(root, "fake-claude", `
const fs = require("node:fs");
fs.writeFileSync(process.env.INERTIA_TEST_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "Partial " } } }));
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "reply" } } }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Partial reply" }] } }));
console.log(JSON.stringify({ type: "result", is_error: false }));
setInterval(() => {}, 1000);
`);
    const manager = new ProviderManager(
      {
        commands: { claude: command },
        resolveBackendLaunchOptions: (_input, environment) => ({
          environment: {
            ...environment,
            INERTIA_TEST_CAPTURE_PATH: capturePath,
          },
        }),
      },
      new AgentHarnessRegistry([createCliAgentHarness("claude", { prefixArgs: [program] })]),
    );

    try {
      const result = await manager.run(nativeProviderRunInput({ providerId: "claude", harnessId: "claude-cli", conversationId: "claude-partial", cwd: root, prompt: "Respond", interactionMode: "build", access: "auto-edit" }));

      expect(result).toMatchObject({ status: "completed", text: "Partial reply", cleanupConfirmed: true });
      expect(manager.isRunning("claude-partial")).toBe(false);
      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toContain("--include-partial-messages");
    } finally {
      await manager.disposeAll();
    }
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

    const result = await manager.run(nativeProviderRunInput({ providerId: "codex", harnessId: "codex-cli", conversationId: "failed-conversation", cwd: root, prompt: "Respond", interactionMode: "build", access: "full" }));

    expect(result).toMatchObject({ status: "failed", exitCode: 1, error: "Codex is not authenticated. Sign in with its CLI and try again." });
    expect(result.cleanupConfirmed).toBe(true);
    expect(manager.isRunning("failed-conversation")).toBe(false);
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("fails a clean CLI exit that omitted the provider terminal event", async () => {
    const root = temporaryRoot();
    const { command, program } = nodeProgram(
      root,
      "incomplete-codex",
      "process.exit(0);",
    );
    const manager = new ProviderManager(
      { commands: { codex: command } },
      new AgentHarnessRegistry([
        createCliAgentHarness("codex", { prefixArgs: [program] }),
      ]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "codex",
      harnessId: "codex-cli",
      conversationId: "incomplete-conversation",
      cwd: root,
      prompt: "Respond",
      interactionMode: "build",
      access: "full",
    }))).resolves.toMatchObject({
      status: "failed",
      exitCode: 0,
      error: "Codex could not complete the request.",
      cleanupConfirmed: true,
    });
    expect(manager.isRunning("incomplete-conversation")).toBe(false);
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });

  it("attributes custom backend failures without echoing raw provider diagnostics", () => {
    const error = providerFailureMessage(
      "codex",
      undefined,
      "HTTP 401 from https://gateway.example.test/v1 Authorization: Bearer raw-secret",
      "",
      {
        id: "custom:team-responses",
        displayName: "Team Responses\nGateway",
        authenticationMode: "bearer-token",
      },
    );

    expect(error).toBe(
      "Authentication failed for Team Responses Gateway. Check this model backend's credential and try again.",
    );
    expect(error).not.toMatch(/gateway\.example|authorization|raw-secret/iu);
  });

  it("cancels a running provider and settles its run exactly once", async () => {
    const root = temporaryRoot();
    const command = codexExecutable(root, "waiting-codex", { stayAlive: true });
    const manager = new ProviderManager({ commands: { codex: command }, cancelGraceMs: 100 });
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const statuses: string[] = [];
    const run = manager.run(
      nativeProviderRunInput({ providerId: "codex", conversationId: "cancel-conversation", cwd: root, prompt: "Wait", interactionMode: "build", access: "full" }),
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
