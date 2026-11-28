// @inertia-test-suite portable
// @inertia-harness antigravity-acp
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeOwnedProcessJournal,
  runtimeOwnedProcessOwnershipIsTainted,
} from "../../src/node/runtime-owned-processes";
import {
  ProcessTreeTerminationError,
  terminateProcessTreeAndWait,
} from "../../src/server/process-lifecycle";
import { ACP_WATCHER_QUESTION_DECLINED } from "../../src/server/provider/acp-watcher";
import {
  probeAntigravityAuthentication,
  selectAntigravityAcpAuthMethod,
} from "../../src/server/provider/antigravity-acp-auth";
import {
  ANTIGRAVITY_ACP_CAPABILITIES,
  antigravityAcpLaunchArguments,
  antigravityAcpProcessInvocation,
  createAntigravityAcpHarness,
} from "../../src/server/provider/antigravity-acp-harness";
import { BoundedAntigravityJsonLineTransform } from "../../src/server/provider/antigravity-acp-support";
import { providerAuthLaunchEnvironment } from "../../src/server/provider/auth";
import type { ProviderEvent, ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { ProviderRunEventBudget } from "../../src/server/provider/io";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { INERTIA_VERSION } from "../../src/shared/version";
import { executableProcessExists } from "../helpers/executable-process";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  readStableFixtureCapture,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";
import { nativeProviderRunInput } from "./model-route-fixture";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const INTERNAL_GOOGLE_FLAGS = [
  "--cloud_code_endpoint",
  "--override_user_agent_name",
  "--use_stubby_auth",
  "--is_google3_workspace",
  "--worker",
] as const;

const DEFAULT_AUTH_METHODS = [
  { id: "oauth-personal", name: "Log in with Google", description: "Log in with your Google account" },
  { id: "oauth-business", name: "Log in with Gemini Enterprise" },
  { id: "gemini-api-key", name: "Gemini API key" },
  { id: "agent-platform", name: "Gemini Enterprise Agent Platform" },
  { id: "terminal-login", name: "Log in from the terminal", type: "terminal", args: ["--login"] },
];

const DEFAULT_MODES = {
  currentModeId: "auto",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "accept-edits", name: "Accept edits" },
    { id: "auto", name: "Auto" },
    { id: "plan", name: "Plan" },
  ],
};

const CONFIRMED_DEFAULT_MODE = {
  currentModeId: "default",
  availableModes: [],
};

async function collectFrames(chunks: readonly Buffer[], maxLineBytes = 4 * 1024): Promise<string> {
  const output: Buffer[] = [];
  await pipeline(
    Readable.from(chunks),
    new BoundedAntigravityJsonLineTransform(
      maxLineBytes,
      new ProviderRunEventBudget("Antigravity ACP", maxLineBytes, 16, 16 * 1024),
    ),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  return Buffer.concat(output).toString("utf8");
}

function fakeAgySubcommand(capturePath: string | null, body: string): string {
  const save = capturePath
    ? `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), messages }));`
    : "";
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
${save}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message);
  ${save}
  ${body}
});
`;
}

function initReply(capabilities: Record<string, unknown>, authMethods: unknown = DEFAULT_AUTH_METHODS, agentName = "Antigravity ACP Server"): string {
  return JSON.stringify({
    protocolVersion: 1,
    agentCapabilities: capabilities,
    authMethods,
    agentInfo: { name: agentName, version: "1.5.18" },
  });
}

describe("bounded Antigravity ACP framing", () => {
  it("decodes a valid multibyte frame split into one-byte chunks", async () => {
    const frame = Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { message: "Antigravity \u2603" },
    })}\n`);
    await expect(collectFrames([...frame].map((byte) => Buffer.of(byte))))
      .resolves.toBe(frame.toString("utf8"));
  });

  it("rejects malformed UTF-8 instead of normalizing replacement characters", async () => {
    const frame = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n'),
    ]);
    await expect(collectFrames([frame])).rejects.toThrow(/not valid.*utf-?8/iu);
  });

  it("rejects oversized and malformed JSON-RPC frames", async () => {
    const oversized = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(5_000) })}\n`);
    await expect(collectFrames([oversized], 1_024)).rejects.toThrow(/oversized JSON-RPC frame/iu);
    const malformed = Buffer.from('{"jsonrpc":"1.0","id":1,"result":{}}\n');
    await expect(collectFrames([malformed])).rejects.toThrow(/malformed JSON-RPC frame/iu);
  });
});

describe("Antigravity ACP auth descriptor allowlist", () => {
  it("accepts the documented terminal-login descriptor and agent auth methods", () => {
    expect(selectAntigravityAcpAuthMethod(DEFAULT_AUTH_METHODS, {})).toEqual({
      id: "terminal-login",
      name: "Log in from the terminal",
      type: "terminal",
      args: ["--login"],
      env: {},
    });
    expect(selectAntigravityAcpAuthMethod([
      { id: "oauth-personal", name: "Log in with Google" },
      { id: "gemini-api-key", name: "Gemini API key" },
    ], { GEMINI_API_KEY: "secret-key" })).toEqual({
      id: "gemini-api-key",
      name: "Gemini API key",
    });
    expect(selectAntigravityAcpAuthMethod([
      { id: "oauth-personal", name: "Log in with Google" },
      { id: "agent-platform", name: "Agent Platform" },
    ], { AGY_ADC_AUTH: "true" })).toEqual({
      id: "agent-platform",
      name: "Agent Platform",
    });
    expect(selectAntigravityAcpAuthMethod([], {})).toBeUndefined();
    expect(selectAntigravityAcpAuthMethod(undefined, {})).toBeUndefined();
  });

  it.each<{ methods: unknown[] }>([
    { methods: [{ id: "terminal-login", name: "Login", type: "terminal", args: ["--login", "--evil"] }] },
    { methods: [{ id: "terminal-login", name: "Login", type: "terminal", args: [] }] },
    { methods: [{ id: "other-id", name: "Login", type: "terminal", args: ["--login"] }] },
    { methods: [{ id: "terminal-login", name: "Login", type: "terminal", args: ["--login"], env: { NODE_OPTIONS: "--evil" } }] },
    { methods: [{ id: "terminal-login", name: "Login", type: "terminal", args: ["--login"], env: "bad" }] },
    { methods: [{ id: "terminal-login", name: "Login", type: "other", args: ["--login"] }] },
    { methods: [{ id: "oauth-personal", name: "Dup" }, { id: "oauth-personal", name: "Dup2" }] },
    { methods: [{ id: "oauth-personal", name: "Bad\u0007name" }] },
  ])("rejects tampered auth method descriptors without echoing provider values ($methods)", ({ methods }) => {
    expect(() => selectAntigravityAcpAuthMethod(methods, {}))
      .toThrow("Antigravity ACP returned an unsupported or invalid terminal authentication descriptor.");
  });
});

describe("Antigravity ACP harness", { concurrent: false }, () => {
  const roots: string[] = [];
  const registryDeactivators: Array<() => void> = [];
  const envKeys = ["GEMINI_API_KEY", "AGY_ADC_AUTH", "RANDOM_SECRET"] as const;
  const savedEnv = new Map<string, string | undefined>();

  afterEach(async () => {
    while (registryDeactivators.length > 0) registryDeactivators.pop()?.();
    for (const key of envKeys) {
      const saved = savedEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    savedEnv.clear();
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function rememberEnv(): void {
    for (const key of envKeys) {
      if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    }
  }

  function makeRoot(label: string): string {
    const root = realpathSync(portableFixtureRoot(label));
    roots.push(root);
    return root;
  }

  function managerFor(command: string, harness = createAntigravityAcpHarness()) {
    return ProviderManager.createForTests(
      { commands: { antigravity: command } },
      new AgentHarnessRegistry([harness]),
    );
  }

  function writeFakeAgy(root: string, capturePath: string | null, body: string): string {
    const exe = join(root, process.platform === "win32" ? "agy.exe" : "agy");
    const command = existsSync(exe) ? exe : portableNodeExecutable(root, "agy");
    writeNodeSubcommand(root, "acp", fakeAgySubcommand(capturePath, body));
    return command;
  }

  it("exposes the Antigravity ACP capability contract and shell-free process invocations", () => {
    expect(ANTIGRAVITY_ACP_CAPABILITIES.extension).toEqual({
      kind: "antigravity-acp",
      protocol: "acp-v1-json-rpc",
      approvals: "native",
      questions: "permission-multiplexed",
      plans: "native",
      reasoning: "native",
      usage: "optional-acp-v1",
      images: "capability-negotiated",
      authentication: "antigravity-cli",
      modelMetadata: "session-config-options",
    });

    expect(antigravityAcpProcessInvocation("/usr/local/bin/agy", {}, "linux", ["--stdio", "--process-per-session"]))
      .toEqual({ command: "/usr/local/bin/agy", args: ["acp", "--stdio", "--process-per-session"] });
    expect(antigravityAcpProcessInvocation("/usr/local/bin/agy", {}, "linux", ["--login"]))
      .toEqual({ command: "/usr/local/bin/agy", args: ["acp", "--login"] });
    expect(antigravityAcpProcessInvocation("C:\\Tools\\agy.exe", {}, "win32", ["--stdio"]))
      .toEqual({ command: "C:\\Tools\\agy.exe", args: ["acp", "--stdio"] });

    const windowsCmd = antigravityAcpProcessInvocation(
      "C:\\Tools\\agy.cmd",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
      ["--stdio", "--process-per-session"],
    );
    expect(windowsCmd.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(windowsCmd.windowsVerbatimArguments).toBe(true);
    expect(windowsCmd.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(windowsCmd.args[4]).toContain("agy.cmd");
    expect(windowsCmd.args[4]).toContain("--process-per-session");
  });

  it("gates --dangerously-skip-permissions strictly to non-plan non-watcher Full Access and never emits internal Google flags", () => {
    const cases = [
      [{ interactionMode: "build", access: "supervised" }, ["--stdio", "--process-per-session"]],
      [{ interactionMode: "build", access: "auto-edit" }, ["--stdio", "--process-per-session"]],
      [{ interactionMode: "plan", access: "full" }, ["--stdio", "--process-per-session"]],
      [{ interactionMode: "build", access: "full", readOnlyProfile: "watcher" }, ["--stdio", "--process-per-session"]],
      [{ interactionMode: "build", access: "full" }, ["--stdio", "--process-per-session", "--dangerously-skip-permissions"]],
    ] as const;
    for (const [input, expected] of cases) {
      const args = antigravityAcpLaunchArguments(input);
      expect(args).toEqual(expected);
      for (const forbidden of INTERNAL_GOOGLE_FLAGS) {
        expect(args).not.toContain(forbidden);
      }
    }
  });

  it("sends honest inertia clientInfo, uses cached OAuth without authenticate, sets default mode in supervised, and closes session cleanly", async () => {
    rememberEnv();
    delete process.env.GEMINI_API_KEY;
    delete process.env.AGY_ADC_AUTH;
    const root = makeRoot("antigravity ACP cached auth");
    const capturePath = join(root, "capture.json");
    const command = writeFakeAgy(root, capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({
        loadSession: true,
        promptCapabilities: { image: true },
        mcpCapabilities: { http: true },
        sessionCapabilities: { resume: {}, close: {} },
      })} });
      if (message.method === "authenticate") throw new Error("Cached OAuth must not trigger interactive authenticate.");
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-sess-1",
        modes: ${JSON.stringify(DEFAULT_MODES)},
        configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello from Antigravity" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
      if (message.method === "session/close") return send({ jsonrpc: "2.0", id: message.id, result: {} });
    `);

    const result = await managerFor(command).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-cached",
      cwd: root,
      prompt: "Say hello",
      interactionMode: "build",
      access: "supervised",
    }));

    expect(result).toMatchObject({
      status: "completed",
      sessionId: "agy-sess-1",
      text: "Hello from Antigravity",
      cleanupConfirmed: true,
    });
    const captured = readStableFixtureCapture<{
      pid: number;
      argv: string[];
      messages: Array<{ method?: string; params?: Record<string, unknown> }>;
    }>(capturePath);
    expect(captured.argv).toEqual(["--stdio", "--process-per-session"]);
    for (const forbidden of INTERNAL_GOOGLE_FLAGS) expect(captured.argv).not.toContain(forbidden);
    expect(captured.messages[0]).toMatchObject({
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "inertia", version: INERTIA_VERSION },
        clientCapabilities: { auth: { terminal: true }, plan: {} },
      },
    });
    expect(captured.messages[0]?.params?.clientCapabilities).not.toHaveProperty("session");
    expect(captured.messages.map(({ method }) => method)).toEqual([
      "initialize",
      "session/new",
      "session/set_mode",
      "session/prompt",
      "session/close",
    ]);
    expect(captured.messages.find(({ method }) => method === "session/set_mode")?.params)
      .toEqual({ sessionId: "agy-sess-1", modeId: "default" });
    expect(executableProcessExists(captured.pid)).toBe(false);
  });

  it("authenticates with gemini-api-key when GEMINI_API_KEY is set and redacts it from streamed output and stderr", async () => {
    rememberEnv();
    process.env.GEMINI_API_KEY = "AIzaSy-SecretAntigravityKey-99999";
    delete process.env.AGY_ADC_AUTH;
    const root = makeRoot("antigravity ACP api key");
    const capturePath = join(root, "capture.json");
    const command = writeFakeAgy(root, capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-key",
        modes: ${JSON.stringify(DEFAULT_MODES)},
        configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/prompt") {
        process.stderr.write("debug key=AIzaSy-SecretAntigravityKey-99999\\n");
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-key", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Leaked AIzaSy-SecretAntigravity" } } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-key", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Key-99999 done" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);

    const result = await managerFor(command).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-key",
      cwd: root,
      prompt: "Check key",
      interactionMode: "build",
      access: "supervised",
    }));

    expect(result.status).toBe("completed");
    expect(result.text).not.toContain("AIzaSy-SecretAntigravityKey-99999");
    expect(result.text).toContain("[redacted]");
    const captured = readStableFixtureCapture<{ messages: Array<{ method?: string; params?: unknown }> }>(capturePath);
    expect(captured.messages.find(({ method }) => method === "authenticate")?.params)
      .toEqual({ methodId: "gemini-api-key" });
  });

  it("authenticates with agent-platform when AGY_ADC_AUTH is enabled", async () => {
    rememberEnv();
    delete process.env.GEMINI_API_KEY;
    process.env.AGY_ADC_AUTH = "1";
    const root = makeRoot("antigravity ACP adc auth");
    const capturePath = join(root, "capture.json");
    const command = writeFakeAgy(root, capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-adc",
        modes: ${JSON.stringify(DEFAULT_MODES)},
        configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-adc", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ADC ok" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);

    const result = await managerFor(command).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-adc",
      cwd: root,
      prompt: "Run ADC",
      interactionMode: "build",
      access: "supervised",
    }));

    expect(result).toMatchObject({ status: "completed", text: "ADC ok" });
    const captured = readStableFixtureCapture<{ messages: Array<{ method?: string; params?: unknown }> }>(capturePath);
    expect(captured.messages.find(({ method }) => method === "authenticate")?.params)
      .toEqual({ methodId: "agent-platform" });
  });

  it("maps JSON-RPC -32000 Authentication required on session/new to phase: auth", async () => {
    rememberEnv();
    delete process.env.GEMINI_API_KEY;
    delete process.env.AGY_ADC_AUTH;
    const root = makeRoot("antigravity ACP unauthenticated");
    const capturePath = join(root, "capture.json");
    const command = writeFakeAgy(root, capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
    `);

    const result = await managerFor(command).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-unauth",
      cwd: root,
      prompt: "Hello",
      interactionMode: "build",
      access: "supervised",
    }));

    expect(result).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      error: "Antigravity is not authenticated. Connect Antigravity in provider settings, then try again.",
      failure: {
        reason: "provider-error",
        phase: "auth",
        terminalEvent: "session/new",
      },
    });
  });

  it("probes terminal-login auth with honest clientInfo, rejects tampered descriptors, and retires guardian claims", async () => {
    const root = makeRoot("antigravity ACP auth probe");
    const capturePath = join(root, "probe-capture.json");
    const command = writeFakeAgy(root, capturePath, `
      const descendant = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: false });
      fs.writeFileSync(${JSON.stringify(join(root, "descendant.json"))}, JSON.stringify({ pid: process.pid, descendantPid: descendant.pid }));
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
    `);
    const registryRoot = join(root, "runtime-owned");
    mkdirSync(registryRoot);
    chmodSync(registryRoot, 0o700);
    const generation = "81000000-0000-4000-8000-000000000081:1";
    const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
      registryRoot,
      generation,
      "test:81000000-0000-4000-8000-000000000081",
      process.platform === "linux" || process.platform === "darwin"
        ? { darwinGuardianPath: join(process.cwd(), "resources/generated/runtime-process-guardian/runtime-process-guardian") }
        : {},
    );
    if (deactivate) registryDeactivators.push(deactivate);
    const journal = new RuntimeOwnedProcessJournal(registryRoot);

    const discovered = await probeAntigravityAuthentication(command, root, { PATH: process.env.PATH });
    expect(discovered).toEqual({
      id: "terminal-login",
      name: "Log in from the terminal",
      type: "terminal",
      args: ["--login"],
      env: {},
    });
    const proc = readStableFixtureCapture<{ pid: number; descendantPid: number }>(join(root, "descendant.json"));
    expect(executableProcessExists(proc.pid)).toBe(false);
    expect(executableProcessExists(proc.descendantPid)).toBe(false);
    expect(journal.records(generation)).toHaveLength(0);
    expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);

    const badRoot = makeRoot("antigravity ACP bad auth probe");
    const badCommand = writeFakeAgy(badRoot, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply(
        {},
        [{ id: "terminal-login", name: "Bad", type: "terminal", args: ["--secret-evil-arg"], env: { EVIL: "1" } }],
      )} });
    `);
    const badError = await probeAntigravityAuthentication(badCommand, badRoot, { PATH: process.env.PATH })
      .then(() => undefined, (error: unknown) => error);
    expect(badError).toBeInstanceOf(Error);
    expect((badError as Error).message).toContain("Antigravity authentication discovery");
    expect((badError as Error).message).not.toContain("--secret-evil-arg");

    const unconfirmedError = await probeAntigravityAuthentication(command, root, { PATH: process.env.PATH }, undefined, {
      terminateProcessTree: async (child, force) => {
        await terminateProcessTreeAndWait(child, force);
        return false;
      },
    }).then(() => undefined, (error: unknown) => error);
    expect(unconfirmedError).toBeInstanceOf(ProcessTreeTerminationError);
  });

  it("enforces Supervised, Auto-edit, Plan, Full Access, Read-only Watcher, and attachmentReadRoots permission policies", async () => {
    const root = makeRoot("antigravity ACP permissions");
    const attachDir = join(root, "attachments");
    mkdirSync(attachDir);
    const attachFile = join(attachDir, "note.txt");
    writeFileSync(attachFile, "hi");

    // 1. Supervised: splits execute command vs detail, picks allow_once / reject_once (never allow_always), auto-allows attachmentReadRoots
    const supCapture = join(root, "sup.json");
    const supCommand = writeFakeAgy(root, supCapture, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-sup", modes: ${JSON.stringify(DEFAULT_MODES)}, configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", id: "perm-read", method: "session/request_permission", params: {
          sessionId: "agy-sup",
          toolCall: { toolCallId: "tc-read", title: "Read attachment", kind: "read", locations: [{ path: ${JSON.stringify(attachFile)} }] },
          options: [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "once", name: "Once", kind: "allow_once" }],
        } });
        return;
      }
      if (message.id === "perm-read") {
        send({ jsonrpc: "2.0", id: "perm-cmd", method: "session/request_permission", params: {
          sessionId: "agy-sup",
          toolCall: { toolCallId: "tc-cmd", title: "Run tests", kind: "execute", rawInput: { command: "npm test", description: "Run unit tests" } },
          options: [
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "allow1", name: "Allow once", kind: "allow_once" },
            { optionId: "reject1", name: "Reject once", kind: "reject_once" },
          ],
        } });
        return;
      }
      if (message.id === "perm-cmd") {
        send({ jsonrpc: "2.0", id: "perm-deny", method: "session/request_permission", params: {
          sessionId: "agy-sup",
          toolCall: { toolCallId: "tc-edit", title: "Edit file", kind: "edit", rawInput: { path: "a.ts" } },
          options: [
            { optionId: "allow1", name: "Allow once", kind: "allow_once" },
            { optionId: "reject1", name: "Reject once", kind: "reject_once" },
          ],
        } });
        return;
      }
      if (message.id === "perm-deny") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-sup", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Permissions verified" } } } });
        return send({ jsonrpc: "2.0", id: messages.find(m => m.method === "session/prompt").id, result: { stopReason: "end_turn" } });
      }
    `);

    const mgr = managerFor(supCommand);
    const seenApprovals: Array<{ kind: string; command?: string; detail?: string }> = [];
    const supResult = await mgr.run(
      nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-sup",
        cwd: root,
        prompt: "Run checks",
        interactionMode: "build",
        access: "supervised",
        attachmentReadRoots: [attachDir],
      }),
      {
        onEvent: (event: ProviderEvent) => {
          if (event.type === "approval") {
            seenApprovals.push({
              kind: event.request.kind,
              command: event.request.command,
              detail: event.request.detail,
            });
            mgr.respondToApproval(
              "agy-sup",
              event.request.requestId,
              seenApprovals.length === 1 ? "approve" : "deny",
              { runId: event.runId, turnId: event.turnId },
            );
          }
        },
      },
    );
    expect(supResult).toMatchObject({ status: "completed", text: "Permissions verified" });
    expect(seenApprovals).toEqual([
      { kind: "command", command: "npm test", detail: "Run unit tests" },
      { kind: "file-change", command: undefined, detail: expect.stringContaining("a.ts") },
    ]);
    const supCaptured = readStableFixtureCapture<{ messages: Array<{ id?: unknown; result?: unknown }> }>(supCapture);
    expect(supCaptured.messages.find(({ id }) => id === "perm-read")?.result).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    });
    expect(supCaptured.messages.find(({ id }) => id === "perm-cmd")?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow1" },
    });
    expect(supCaptured.messages.find(({ id }) => id === "perm-deny")?.result).toEqual({
      outcome: { outcome: "selected", optionId: "reject1" },
    });

    // 2. Auto-edit: sets accept-edits, auto-allows edit via allow_once, asks user for execute!
    const autoCapture = join(root, "auto.json");
    const autoCommand = writeFakeAgy(root, autoCapture, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-auto", modes: ${JSON.stringify(DEFAULT_MODES)}, configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", id: "ae-edit", method: "session/request_permission", params: {
          sessionId: "agy-auto",
          toolCall: { toolCallId: "tc1", title: "Edit", kind: "edit" },
          options: [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "once", name: "Once", kind: "allow_once" }],
        } });
        return;
      }
      if (message.id === "ae-edit") {
        send({ jsonrpc: "2.0", id: "ae-exec", method: "session/request_permission", params: {
          sessionId: "agy-auto",
          toolCall: { toolCallId: "tc2", title: "Exec", kind: "execute", rawInput: { command: "rm -rf build" } },
          options: [{ optionId: "once", name: "Once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
        } });
        return;
      }
      if (message.id === "ae-exec") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-auto", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Auto-edit done" } } } });
        return send({ jsonrpc: "2.0", id: messages.find(m => m.method === "session/prompt").id, result: { stopReason: "end_turn" } });
      }
    `);
    const autoMgr = managerFor(autoCommand);
    const autoPrompts: string[] = [];
    const autoRes = await autoMgr.run(
      nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-auto",
        cwd: root,
        prompt: "Edit and run",
        interactionMode: "build",
        access: "auto-edit",
      }),
      {
        onEvent: (event: ProviderEvent) => {
          if (event.type === "approval") {
            autoPrompts.push(event.request.command ?? event.request.title);
            autoMgr.respondToApproval(
              "agy-auto",
              event.request.requestId,
              "deny",
              { runId: event.runId, turnId: event.turnId },
            );
          }
        },
      },
    );
    expect(autoRes).toMatchObject({ status: "completed", text: "Auto-edit done" });
    expect(autoPrompts).toEqual(["rm -rf build"]);
    const autoCaptured = readStableFixtureCapture<{ messages: Array<{ method?: string; id?: unknown; params?: unknown; result?: unknown }> }>(autoCapture);
    expect(autoCaptured.messages.find(({ method }) => method === "session/set_mode")?.params)
      .toEqual({ sessionId: "agy-auto", modeId: "accept-edits" });
    expect(autoCaptured.messages.find(({ id }) => id === "ae-edit")?.result)
      .toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(autoCaptured.messages.find(({ id }) => id === "ae-exec")?.result)
      .toEqual({ outcome: { outcome: "selected", optionId: "no" } });

    // 3. Plan mode & Read-only watcher & Full Access (allow_once only, never allow_always)
    const policyCases = [
      { name: "plan", interactionMode: "plan" as const, access: "full" as const, watcher: false, expectedMode: "plan", expectedArg: false, expectedOutcome: { outcome: "selected", optionId: "reject1" }, expectCard: false },
      { name: "watcher", interactionMode: "plan" as const, access: "supervised" as const, watcher: true, expectedMode: "plan", expectedArg: false, expectedOutcome: { outcome: "selected", optionId: "reject1" }, expectCard: true },
      { name: "full", interactionMode: "build" as const, access: "full" as const, watcher: false, expectedMode: null, expectedArg: true, expectedOutcome: { outcome: "selected", optionId: "allow1" }, expectCard: false },
    ];
    for (const c of policyCases) {
      const cap = join(root, `policy-${c.name}.json`);
      const cmd = writeFakeAgy(root, cap, `
        if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
        if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
          sessionId: "agy-${c.name}", modes: ${JSON.stringify(DEFAULT_MODES)}, configOptions: [],
        } });
        if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
        if (message.method === "session/prompt") {
          send({ jsonrpc: "2.0", id: "p1", method: "session/request_permission", params: {
            sessionId: "agy-${c.name}",
            toolCall: { toolCallId: "t1", title: "Enterprise review", kind: "edit" },
            options: [
              { optionId: "always", name: "Always", kind: "allow_always" },
              { optionId: "allow1", name: "Once", kind: "allow_once" },
              { optionId: "reject1", name: "Reject", kind: "reject_once" },
            ],
          } });
          return;
        }
        if (message.id === "p1") {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-${c.name}", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok-${c.name}" } } } });
          return send({ jsonrpc: "2.0", id: messages.find(m => m.method === "session/prompt").id, result: { stopReason: "end_turn" } });
        }
      `);
      const m = managerFor(cmd);
      let cards = 0;
      const runInput = {
        ...nativeProviderRunInput({
          providerId: "antigravity",
          conversationId: `agy-${c.name}`,
          cwd: root,
          prompt: "Check policy",
          interactionMode: c.interactionMode,
          access: c.access,
        }),
        ...(c.watcher ? { readOnlyProfile: "watcher" as const } : {}),
      };
      const res = await m.run(runInput, {
        onEvent: (event: ProviderEvent) => {
          if (event.type === "approval") {
            cards += 1;
            m.respondToApproval(
              `agy-${c.name}`,
              event.request.requestId,
              "deny",
              { runId: event.runId, turnId: event.turnId },
            );
          }
        },
      });
      expect(res).toMatchObject({ status: "completed", text: `ok-${c.name}` });
      expect(cards).toBe(c.expectCard ? 1 : 0);
      const data = readStableFixtureCapture<{ argv: string[]; messages: Array<{ method?: string; id?: unknown; params?: unknown; result?: unknown }> }>(cap);
      expect(data.argv.includes("--dangerously-skip-permissions")).toBe(c.expectedArg);
      const setMode = data.messages.find(({ method }) => method === "session/set_mode");
      if (c.expectedMode) expect(setMode?.params).toEqual({ sessionId: `agy-${c.name}`, modeId: c.expectedMode });
      else expect(setMode).toBeUndefined();
      expect(data.messages.find(({ id }) => id === "p1")?.result).toEqual({ outcome: c.expectedOutcome });
    }
  });

  it("projects models, low/medium/high/xhigh/max efforts, and safely skips thought_level for fixed-effort Orchestrator", async () => {
    const root = makeRoot("antigravity ACP models efforts");
    const capturePath = join(root, "capture.json");
    const neonConfig = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gemini-4-neon",
        options: [
          { value: "gemini-4-neon", name: "Gemini 4 Neon" },
          { value: "orchestrator", name: "Orchestrator" },
        ],
      },
      {
        id: "thought_level",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "low" },
          { value: "medium", name: "medium" },
          { value: "high", name: "high" },
          { value: "xhigh", name: "xhigh" },
          { value: "max", name: "max" },
        ],
      },
    ];
    const orchestratorConfig = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "orchestrator",
        options: [
          { value: "gemini-4-neon", name: "Gemini 4 Neon" },
          { value: "orchestrator", name: "Orchestrator" },
        ],
      },
    ];
    const command = writeFakeAgy(root, capturePath, `
      let current = ${JSON.stringify(neonConfig)};
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({
        promptCapabilities: { image: true },
      })} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-models", modes: ${JSON.stringify(DEFAULT_MODES)}, configOptions: current,
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/set_config_option") {
        if (message.params.configId === "model" && message.params.value === "orchestrator") {
          current = ${JSON.stringify(orchestratorConfig)};
        } else {
          current = current.map((opt) => opt.id === message.params.configId ? { ...opt, currentValue: message.params.value } : opt);
        }
        return send({ jsonrpc: "2.0", id: message.id, result: { configOptions: current } });
      }
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-models", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Model configured" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);

    const neonManager = managerFor(command);
    const neonMeta: unknown[] = [];
    const cachedDuringEvent: unknown[] = [];
    const neonResult = await neonManager.run(
      nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-neon",
        cwd: root,
        prompt: "Think hard",
        model: "gemini-4-neon",
        reasoningEffort: "xhigh",
        interactionMode: "build",
        access: "supervised",
      }),
      {
        onEvent: (event: ProviderEvent) => {
          if (event.type === "metadata" && event.metadata.models) {
            neonMeta.push(event.metadata.models);
            cachedDuringEvent.push(neonManager.cachedMetadata("antigravity").models);
          }
        },
      },
    );
    expect(neonResult.status).toBe("completed");
    expect(cachedDuringEvent[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "gemini-4-neon",
        isDefault: true,
        reasoningObserved: true,
      }),
    ]));
    expect(neonMeta[0]).toEqual([
      expect.objectContaining({
        id: "gemini-4-neon",
        isDefault: true,
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "xhigh",
        reasoningObserved: true,
        reasoningOptions: [
          expect.objectContaining({ value: "low", label: "Low" }),
          expect.objectContaining({ value: "medium", label: "Medium" }),
          expect.objectContaining({ value: "high", label: "High" }),
          expect.objectContaining({ value: "xhigh", label: "Extra high" }),
          expect.objectContaining({ value: "max", label: "Max" }),
        ],
      }),
      expect.objectContaining({
        id: "orchestrator",
        isDefault: false,
        reasoningOptions: [],
        defaultReasoningEffort: "",
        reasoningObserved: false,
      }),
    ]);

    // Fixed-effort Orchestrator: safely skips thought_level even if reasoningEffort was passed!
    const orchMeta: unknown[] = [];
    const orchResult = await managerFor(command).run(
      nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-orch",
        cwd: root,
        prompt: "Orchestrate",
        model: "orchestrator",
        reasoningEffort: "xhigh",
        interactionMode: "build",
        access: "supervised",
      }),
      {
        onEvent: (event: ProviderEvent) => {
          if (event.type === "metadata" && event.metadata.models) {
            orchMeta.push(event.metadata.models);
          }
        },
      },
    );
    expect(orchResult.status).toBe("completed");
    expect(orchMeta[0]).toEqual([
      expect.objectContaining({ id: "gemini-4-neon", isDefault: false, reasoningObserved: false, reasoningOptions: [] }),
      expect.objectContaining({ id: "orchestrator", isDefault: true, reasoningObserved: true, reasoningOptions: [], defaultReasoningEffort: "" }),
    ]);
    const orchCaptured = readStableFixtureCapture<{ messages: Array<{ method?: string; params?: { configId?: string } }> }>(capturePath);
    expect(orchCaptured.messages.filter(({ method }) => method === "session/set_config_option").map(({ params }) => params?.configId))
      .toEqual(["model"]);
  });

  it("handles capability-negotiated image attachments (sent when advertised, rejected when absent)", async () => {
    const root = makeRoot("antigravity ACP images");
    const imagePath = join(root, "pixel.png");
    writeFileSync(imagePath, PNG_1X1);

    const cap = join(root, "img-ok.json");
    const okCmd = writeFakeAgy(root, cap, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({
        promptCapabilities: { image: true },
      })} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agy-img", modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-img", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Saw image" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);
    const okResult = await managerFor(okCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-img-ok",
      cwd: root,
      prompt: "Describe image",
      imagePaths: [imagePath],
      interactionMode: "build",
      access: "supervised",
    }));
    expect(okResult).toMatchObject({ status: "completed", text: "Saw image" });
    const promptMsg = readStableFixtureCapture<{ messages: Array<{ method?: string; params?: { prompt?: unknown[] } }> }>(cap)
      .messages.find(({ method }) => method === "session/prompt");
    expect(promptMsg?.params?.prompt).toEqual([
      { type: "image", mimeType: "image/png", data: PNG_1X1.toString("base64") },
      { type: "text", text: "Describe image" },
    ]);

    const noImgCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({
        promptCapabilities: { image: false },
      })} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agy-no-img", modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      if (message.method === "session/prompt") throw new Error("Prompt must not be sent without image capability.");
    `);
    const noImgResult = await managerFor(noImgCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-img-no",
      cwd: root,
      prompt: "Describe image",
      imagePaths: [imagePath],
      interactionMode: "build",
      access: "supervised",
    }));
    expect(noImgResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      error: expect.stringMatching(/did not advertise image support/iu),
    });
  });

  it("bridges host tools over HTTP MCP (with Bearer & URL redaction) and falls back to stdio proxy when HTTP MCP is unadvertised", async () => {
    const root = makeRoot("antigravity ACP host mcp");
    const hostTools: ProviderHostToolBridge = {
      definitions: [
        {
          name: "echo_host",
          description: "Echo from Inertia host",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          readOnly: true,
        },
      ],
      invoke: async (call) => ({
        success: true,
        text: JSON.stringify({ echoed: (call.arguments as { value: string }).value }),
      }),
    };

    // 1. HTTP MCP advertised via snake_case mcp_capabilities.http: true
    const httpCap = join(root, "mcp-http.json");
    const httpCmd = writeFakeAgy(root, httpCap, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({
        mcp_capabilities: { http: true },
      })} });
      if (message.method === "session/new") {
        return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agy-mcp", modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      }
      if (message.method === "session/prompt") {
        (async () => {
          const mcpServer = messages.find((m) => m.method === "session/new").params.mcpServers[0];
          const authHeader = mcpServer.headers.find((h) => h.name === "Authorization").value;
          const token = authHeader.replace(/^Bearer\\s+/, "");
          const res = await fetch(mcpServer.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: authHeader },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo_host", arguments: { value: "pong" } } }),
          });
          const body = await res.text();
          send({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: "agy-mcp",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Tool=" + body + " url=" + mcpServer.url + " tok=" + token } },
          } });
          send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        })();
      }
    `);

    const httpResult = await managerFor(httpCmd).run(
      nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-mcp-http",
        cwd: root,
        prompt: "Call host tool",
        interactionMode: "build",
        access: "supervised",
      }),
      { hostTools },
    );
    expect(httpResult.status).toBe("completed");
    expect(httpResult.text).toContain("pong");
    const httpSessionNew = readStableFixtureCapture<{
      messages: Array<{ method?: string; params?: { mcpServers?: Array<{ type?: string; url?: string; headers?: Array<{ name: string; value: string }> }> } }>;
    }>(httpCap).messages.find(({ method }) => method === "session/new");
    const serverSpec = httpSessionNew?.params?.mcpServers?.[0];
    expect(serverSpec?.type).toBe("http");
    expect(serverSpec?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
    const token = serverSpec?.headers?.find(({ name }) => name === "Authorization")?.value.replace(/^Bearer\s+/u, "") ?? "";
    expect(token.length).toBeGreaterThan(16);
    expect(httpResult.text).not.toContain(token);
    expect(httpResult.text).not.toContain(serverSpec!.url!);

    // 2. Fallback to stdio proxy when HTTP MCP is not advertised
    const stdioCap = join(root, "mcp-stdio.json");
    const stdioCmd = writeFakeAgy(root, stdioCap, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agy-stdio", modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-stdio", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Stdio ok" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);
    const stdioResult = await managerFor(stdioCmd).run(
      nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-mcp-stdio",
        cwd: root,
        prompt: "Use stdio proxy",
        interactionMode: "build",
        access: "supervised",
      }),
      { hostTools },
    );
    expect(stdioResult).toMatchObject({ status: "completed", text: "Stdio ok" });
    const stdioServer = readStableFixtureCapture<{
      messages: Array<{ method?: string; params?: { mcpServers?: Array<{ command?: string; args?: string[] }> } }>;
    }>(stdioCap).messages.find(({ method }) => method === "session/new")?.params?.mcpServers?.[0];
    expect(stdioServer?.command).toBeTruthy();
    expect(stdioServer?.args).toContain("-e");
  });

  it("streams reasoning, tool diffs with textBoundary and acpFileMutation, plans, slash commands, usage, and sessionTitle", async () => {
    const root = makeRoot("antigravity ACP streaming");
    const command = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "agy-stream",
          update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review changes" }] },
        } });
        return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agy-stream", modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      }
      if (message.method === "session/prompt") {
        const s = "agy-stream";
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking deeply..." } } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "plan", entries: [{ content: "Inspect", priority: "high", status: "in_progress" }, { content: "Patch", priority: "medium", status: "pending" }] } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before tool" } } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "tool_call", toolCallId: "tc-edit", title: "Edit app.ts", kind: "edit", status: "pending", locations: [{ path: "app.ts", line: 10 }] } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-edit", status: "in_progress", content: [{ type: "diff", path: "app.ts", oldText: "old", newText: "new" }] } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-edit", status: "completed", rawOutput: "Updated app.ts" } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After tool" } } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "session_info_update", title: "Refactor\\tAntigravity" } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s, update: { sessionUpdate: "usage_update", used: 1200, size: 128000 } } });
        return send({ jsonrpc: "2.0", id: message.id, result: {
          stopReason: "end_turn",
          usage: { inputTokens: 800, outputTokens: 400, thoughtTokens: 150, cachedReadTokens: 200, cachedWriteTokens: 50, totalTokens: 1400 },
        } });
      }
    `);

    const events: ProviderEvent[] = [];
    const result = await managerFor(command).run(
      nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-stream",
        cwd: root,
        prompt: "Refactor",
        interactionMode: "build",
        access: "supervised",
      }),
      { onEvent: (event) => events.push(event) },
    );

    expect(result).toMatchObject({
      status: "completed",
      text: "Before tool\n\nAfter tool",
      cleanupConfirmed: true,
    });
    expect(events.some((e) => e.type === "text-boundary")).toBe(true);
    expect(events.some((e) => e.type === "session-title" && e.sessionId === "agy-stream" && e.title === "Refactor Antigravity")).toBe(true);
    expect(events.some((e) => e.type === "reasoning-summary" && e.text.includes("Thinking deeply"))).toBe(true);
    expect(events.some((e) => e.type === "plan" && e.steps.length === 2 && e.steps[0]?.status === "inProgress")).toBe(true);
    expect(events.some((e) => e.type === "metadata" && Array.isArray(e.metadata.commands) && e.metadata.commands.some((c) => c.name === "review"))).toBe(true);

    const toolActivities = events.filter((e) => e.type === "activity" && e.activityId === "tc-edit");
    expect(toolActivities).toHaveLength(3);
    expect(toolActivities[0]).not.toHaveProperty("fileMutation");
    expect(toolActivities[1]).toMatchObject({ fileMutation: true });
    expect(toolActivities[2]).toMatchObject({ phase: "completed" });

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[1]).toMatchObject({
      type: "usage",
      usage: {
        usedTokens: 1200,
        maxTokens: 128000,
        inputTokens: 800,
        outputTokens: 400,
        reasoningOutputTokens: 150,
        cachedInputTokens: 200,
        cacheWriteInputTokens: 50,
        totalProcessedTokens: 1400,
      },
    });
  });

  it("prefers session/resume, falls back to session/load with replay suppression, and maps -32002 to sessionUnavailable", async () => {
    const root = makeRoot("antigravity ACP resume load");

    // 1. session/resume preferred when advertised
    const resumeCap = join(root, "resume.json");
    const resumeCmd = writeFakeAgy(root, resumeCap, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({
        loadSession: true,
        sessionCapabilities: { resume: {} },
      })} });
      if (message.method === "session/resume") return send({ jsonrpc: "2.0", id: message.id, result: { modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-r1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Resumed" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);
    const resumeResult = await managerFor(resumeCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-resume",
      sessionId: "sess-r1",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(resumeResult).toMatchObject({ status: "completed", text: "Resumed" });
    expect(readStableFixtureCapture<{ messages: Array<{ method?: string }> }>(resumeCap).messages.map(({ method }) => method))
      .toEqual(["initialize", "session/resume", "session/prompt"]);

    // 2. session/load fallback suppresses replayed history chunks AND post-prompt trailing chunks
    const loadCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({
        loadSession: true,
      })} });
      if (message.method === "session/load") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-l1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STALE REPLAY " } } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-l1", update: { sessionUpdate: "tool_call", toolCallId: "stale-tc", title: "Old tool" } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      }
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-l1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fresh turn" } } } });
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-l1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " LATE FRAME" } } } });
      }
    `);
    const loadEvents: ProviderEvent[] = [];
    const loadResult = await managerFor(loadCmd).run(
      nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-load",
        sessionId: "sess-l1",
        cwd: root,
        prompt: "Next turn",
        interactionMode: "build",
        access: "supervised",
      }),
      { onEvent: (e) => loadEvents.push(e) },
    );
    expect(loadResult).toMatchObject({ status: "completed", text: "Fresh turn" });
    expect(loadEvents.some((e) => e.type === "activity" && e.activityId === "stale-tc")).toBe(false);

    // 3. -32002 on session/resume -> sessionUnavailable: true
    const missingCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({
        sessionCapabilities: { resume: {} },
      })} });
      if (message.method === "session/resume") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Resource not found" } });
    `);
    const missingResult = await managerFor(missingCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-missing",
      sessionId: "sess-gone",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(missingResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: {
        sessionUnavailable: true,
        resumeRejected: true,
      },
    });
  });

  it("cancels cleanly via session/cancel, closes session, confirms tree cleanup, and retires runtime guardian claims", async () => {
    const root = makeRoot("antigravity ACP cancel");
    const capturePath = join(root, "cancel.json");
    const command = writeFakeAgy(root, capturePath, `
      let promptId = null;
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({
        sessionCapabilities: { close: {} },
      })} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agy-cancel", modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      if (message.method === "session/prompt") {
        promptId = message.id;
        return;
      }
      if (message.method === "session/cancel") {
        const p = messages.find((m) => m.method === "session/prompt");
        if (p) send({ jsonrpc: "2.0", id: p.id, result: { stopReason: "cancelled" } });
        return;
      }
      if (message.method === "session/close") return send({ jsonrpc: "2.0", id: message.id, result: {} });
    `);

    const registryRoot = join(root, "runtime-owned");
    mkdirSync(registryRoot);
    chmodSync(registryRoot, 0o700);
    const generation = "82000000-0000-4000-8000-000000000082:1";
    const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
      registryRoot,
      generation,
      "test:82000000-0000-4000-8000-000000000082",
      process.platform === "linux" || process.platform === "darwin"
        ? { darwinGuardianPath: join(process.cwd(), "resources/generated/runtime-process-guardian/runtime-process-guardian") }
        : {},
    );
    if (deactivate) registryDeactivators.push(deactivate);
    const journal = new RuntimeOwnedProcessJournal(registryRoot);

    const mgr = managerFor(command);
    const pending = mgr.run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-cancel",
      cwd: root,
      prompt: "Long task",
      interactionMode: "build",
      access: "supervised",
    }));
    await waitFor("session/prompt received", () => {
      if (!existsSync(capturePath)) return false;
      const data = readStableFixtureCapture<{ messages: Array<{ method?: string }> }>(capturePath);
      return data.messages.some(({ method }) => method === "session/prompt");
    });
    mgr.cancel("agy-cancel");
    const result = await pending;
    expect(result).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
    const captured = readStableFixtureCapture<{ pid: number; messages: Array<{ method?: string }> }>(capturePath);
    expect(captured.messages.map(({ method }) => method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "session/cancel",
      "session/close",
    ]);
    expect(executableProcessExists(captured.pid)).toBe(false);
    expect(journal.records(generation)).toHaveLength(0);
    expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
  });

  it("fails closed on empty end_turn, wrong agentInfo identity, malformed frames, and unsupported compact operation", async () => {
    const root = makeRoot("antigravity ACP fail-closed");

    // 1. Empty end_turn
    const emptyCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agy-empty", modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      if (message.method === "session/prompt") return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    `);
    const emptyResult = await managerFor(emptyCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-empty",
      cwd: root,
      prompt: "Empty",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(emptyResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: {
        reason: "provider-error",
        terminalEvent: "session/prompt:empty-end-turn",
      },
    });

    // 2. Wrong agentInfo identity
    const wrongAgentCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({}, [], "Other CLI")} });
    `);
    const wrongAgentResult = await managerFor(wrongAgentCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-wrong-agent",
      cwd: root,
      prompt: "Hello",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(wrongAgentResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { reason: "malformed-protocol" },
    });

    // 3. Malformed frame mid-stream
    const badFrameCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agy-bad", modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      if (message.method === "session/prompt") process.stdout.write("{not-valid-json\\n");
    `);
    const badFrameResult = await managerFor(badFrameCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-bad-frame",
      cwd: root,
      prompt: "Hello",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(badFrameResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { reason: "malformed-protocol", terminalEvent: "transport/frame" },
    });

    // 4. Unsupported compact operation fails cleanly without spawning
    const compactInput = {
      ...nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-compact",
        sessionId: "agy-compact-session",
        cwd: root,
        prompt: "Compact",
        interactionMode: "build",
        access: "supervised",
      }),
      operation: { kind: "compact" as const },
    };
    const compactResult = await createAntigravityAcpHarness().start({
      input: compactInput,
      executable: emptyCmd,
      environment: process.env,
      providerNativeToolsAvailable: true,
    }).result;
    expect(compactResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: {
        reason: "provider-error",
        phase: "operation",
        terminalEvent: "operation/compact-unsupported",
      },
    });
  });

  it("handles native interaction_* structured questions, resolves selected optionId, cancels on abort, and declines in read-only watcher", async () => {
    const root = makeRoot("antigravity ACP interaction questions");
    const capturePath = join(root, "question.json");
    const command = writeFakeAgy(root, capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-q", modes: ${JSON.stringify(DEFAULT_MODES)}, configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", id: "q-1", method: "session/request_permission", params: {
          sessionId: "agy-q",
          toolCall: { toolCallId: "interaction_choice_1", title: "Which database should we target?" },
          options: [
            { optionId: "opt_pg", name: "PostgreSQL", kind: "allow_once" },
            { optionId: "opt_sqlite", name: "SQLite", kind: "allow_once" },
          ],
        } });
        return;
      }
      if (message.id === "q-1") {
        send({ jsonrpc: "2.0", id: "q-dup", method: "session/request_permission", params: {
          sessionId: "agy-q",
          toolCall: { toolCallId: "interaction_bad_dup", title: "Broken duplicate ids" },
          options: [
            { optionId: "same", name: "A", kind: "allow_once" },
            { optionId: "same", name: "B", kind: "allow_once" },
          ],
        } });
        return;
      }
      if (message.id === "q-dup") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-q", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Question answered" } } } });
        return send({ jsonrpc: "2.0", id: messages.find(m => m.method === "session/prompt").id, result: { stopReason: "end_turn" } });
      }
    `);

    const mgr = managerFor(command);
    const seenInputs: Array<{ requestId: string; questionId: string; question: string; options: Array<{ id: string; label: string }> }> = [];
    const resolvedIds: string[] = [];
    const result = await mgr.run(
      nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-q",
        cwd: root,
        prompt: "Ask me",
        interactionMode: "build",
        access: "full",
      }),
      {
        onEvent: (event: ProviderEvent) => {
          if (event.type === "input") {
            const q = event.request.questions[0]!;
            seenInputs.push({
              requestId: event.request.requestId,
              questionId: q.id,
              question: q.question,
              options: q.options.map(({ id, label }) => ({ id, label })),
            });
            const identity = { runId: event.runId, turnId: event.turnId };
            expect(mgr.respondToInput("agy-q", event.request.requestId, { [q.id]: ["opt_sqlite"] }, identity)).toBe(true);
            expect(mgr.respondToInput("agy-q", event.request.requestId, { [q.id]: ["opt_pg"] }, identity)).toBe(false);
          } else if (event.type === "input-resolved") {
            resolvedIds.push(event.requestId);
          }
        },
      },
    );

    expect(result).toMatchObject({ status: "completed", text: "Question answered", cleanupConfirmed: true });
    expect(seenInputs).toEqual([{
      requestId: expect.any(String),
      questionId: "interaction_choice_1",
      question: "Which database should we target?",
      options: [
        { id: "opt_pg", label: "PostgreSQL" },
        { id: "opt_sqlite", label: "SQLite" },
      ],
    }]);
    expect(resolvedIds).toEqual([seenInputs[0]!.requestId]);
    const captured = readStableFixtureCapture<{ messages: Array<{ id?: unknown; result?: unknown }> }>(capturePath);
    expect(captured.messages.find(({ id }) => id === "q-1")?.result).toEqual({
      outcome: { outcome: "selected", optionId: "opt_sqlite" },
    });
    expect(captured.messages.find(({ id }) => id === "q-dup")?.result).toEqual({
      outcome: { outcome: "cancelled" },
    });

    // Read-only watcher declines interaction_* questions cleanly without blocking or emitting an input card.
    const watcherCap = join(root, "watcher-q.json");
    const watcherCmd = writeFakeAgy(root, watcherCap, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-wq", modes: ${JSON.stringify(DEFAULT_MODES)}, configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", id: "wq-1", method: "session/request_permission", params: {
          sessionId: "agy-wq",
          toolCall: { toolCallId: "interaction_watcher_1", title: "Should I proceed?" },
          options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }],
        } });
        return;
      }
      if (message.id === "wq-1") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-wq", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Watcher continued" } } } });
        return send({ jsonrpc: "2.0", id: messages.find(m => m.method === "session/prompt").id, result: { stopReason: "end_turn" } });
      }
    `);
    const watcherEvents: ProviderEvent[] = [];
    const watcherResult = await managerFor(watcherCmd).run(
      {
        ...nativeProviderRunInput({
          providerId: "antigravity",
          conversationId: "agy-wq",
          cwd: root,
          prompt: "Check repo",
          interactionMode: "plan",
          access: "supervised",
        }),
        readOnlyProfile: "watcher",
      },
      { onEvent: (event) => watcherEvents.push(event) },
    );
    expect(watcherResult).toMatchObject({ status: "completed", text: "Watcher continued", cleanupConfirmed: true });
    expect(watcherEvents.some((e) => e.type === "input")).toBe(false);
    expect(watcherEvents.some((e) =>
      e.type === "activity" && e.kind === "system" && e.phase === "info" && e.label === ACP_WATCHER_QUESTION_DECLINED,
    )).toBe(true);
    const watcherCaptured = readStableFixtureCapture<{ messages: Array<{ id?: unknown; result?: unknown }> }>(watcherCap);
    expect(watcherCaptured.messages.find(({ id }) => id === "wq-1")?.result).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("extracts PascalCase CommandLine and Cwd/WorkingDirectory in execute approvals and tool updates", async () => {
    const root = makeRoot("antigravity ACP pascal command");
    const subDir = join(root, "pkg");
    mkdirSync(subDir);
    const command = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-cmd", modes: ${JSON.stringify(DEFAULT_MODES)}, configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", id: "perm-pascal", method: "session/request_permission", params: {
          sessionId: "agy-cmd",
          toolCall: {
            toolCallId: "tc-pascal",
            title: "Run shell command",
            kind: "execute",
            rawInput: { CommandLine: "npm run lint", WorkingDirectory: ${JSON.stringify(subDir)}, Description: "Lint workspace" },
          },
          options: [
            { optionId: "allow1", name: "Allow once", kind: "allow_once" },
            { optionId: "reject1", name: "Reject once", kind: "reject_once" },
          ],
        } });
        return;
      }
      if (message.id === "perm-pascal") {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "agy-cmd",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-pascal",
            title: "Run shell command",
            kind: "execute",
            status: "completed",
            rawInput: { CommandLine: "npm run lint", Cwd: ${JSON.stringify(subDir)} },
            rawOutput: "0 errors",
          },
        } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-cmd", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Lint ok" } } } });
        return send({ jsonrpc: "2.0", id: messages.find(m => m.method === "session/prompt").id, result: { stopReason: "end_turn" } });
      }
    `);

    const mgr = managerFor(command);
    const approvals: Array<{ kind: string; command?: string; detail?: string; cwd?: string }> = [];
    const activities: Array<{ activityId?: string; detail?: string }> = [];
    const result = await mgr.run(
      nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: "agy-cmd",
        cwd: root,
        prompt: "Lint it",
        interactionMode: "build",
        access: "supervised",
      }),
      {
        onEvent: (event: ProviderEvent) => {
          if (event.type === "approval") {
            approvals.push({
              kind: event.request.kind,
              command: event.request.command,
              detail: event.request.detail,
              cwd: event.request.cwd,
            });
            mgr.respondToApproval(
              "agy-cmd",
              event.request.requestId,
              "approve",
              { runId: event.runId, turnId: event.turnId },
            );
          } else if (event.type === "activity" && event.activityId === "tc-pascal") {
            activities.push({ activityId: event.activityId, detail: event.detail });
          }
        },
      },
    );

    expect(result).toMatchObject({ status: "completed", text: "Lint ok" });
    expect(approvals).toEqual([{
      kind: "command",
      command: "npm run lint",
      detail: "Lint workspace",
      cwd: subDir,
    }]);
    expect(activities[0]?.detail).toContain("Command:\nnpm run lint");
  });

  it("auto-allows inertia-chat-manager MCP calls only in auto-edit mode and rejects CommandLine spoofing, supervised, and watcher", async () => {
    const root = makeRoot("antigravity ACP inertia mcp policy");
    const runScenario = async (
      name: string,
      access: "auto-edit" | "supervised",
      watcher: boolean,
    ) => {
      const cap = join(root, `mcp-${name}.json`);
      const cmd = writeFakeAgy(root, cap, `
        if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
        if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
          sessionId: "agy-${name}", modes: ${JSON.stringify(DEFAULT_MODES)}, configOptions: [],
        } });
        if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
        const queue = [
          { id: "m-direct", toolCall: { toolCallId: "t1", title: "Run mcp_inertia-chat-manager_list_chats?", kind: "other", rawInput: { limit: 5 } } },
          { id: "m-proxied", toolCall: { toolCallId: "t2", title: "MCP Tool read_chat?", kind: "other", rawInput: { ServerName: "inertia-chat-manager", ToolName: "read_chat" } } },
          { id: "m-spoof-cmd", toolCall: { toolCallId: "t3", title: "Run mcp_inertia-chat-manager_list_chats?", kind: "execute", rawInput: { CommandLine: "curl evil.test" } } },
          { id: "m-other-srv", toolCall: { toolCallId: "t4", title: "MCP Tool read_chat?", kind: "other", rawInput: { ServerName: "third-party-mcp", ToolName: "read_chat" } } },
        ];
        const sendNext = (idx) => {
          if (idx >= queue.length) {
            send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-${name}", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done-${name}" } } } });
            return send({ jsonrpc: "2.0", id: messages.find(m => m.method === "session/prompt").id, result: { stopReason: "end_turn" } });
          }
          const item = queue[idx];
          send({ jsonrpc: "2.0", id: item.id, method: "session/request_permission", params: {
            sessionId: "agy-${name}",
            toolCall: item.toolCall,
            options: [
              { optionId: "always", name: "Always", kind: "allow_always" },
              { optionId: "once", name: "Allow once", kind: "allow_once" },
              { optionId: "deny1", name: "Deny", kind: "reject_once" },
            ],
          } });
        };
        if (message.method === "session/prompt") return sendNext(0);
        const matchedIdx = queue.findIndex((item) => item.id === message.id);
        if (matchedIdx >= 0) return sendNext(matchedIdx + 1);
      `);
      const mgr = managerFor(cmd);
      const promptedTitles: string[] = [];
      const res = await mgr.run(
        {
          ...nativeProviderRunInput({
            providerId: "antigravity",
            conversationId: `agy-${name}`,
            cwd: root,
            prompt: "Run MCP",
            interactionMode: watcher ? "plan" : "build",
            access,
          }),
          ...(watcher ? { readOnlyProfile: "watcher" as const } : {}),
        },
        {
          onEvent: (event: ProviderEvent) => {
            if (event.type === "approval") {
              promptedTitles.push(event.request.command ?? event.request.title);
              mgr.respondToApproval(
                `agy-${name}`,
                event.request.requestId,
                "deny",
                { runId: event.runId, turnId: event.turnId },
              );
            }
          },
        },
      );
      expect(res).toMatchObject({ status: "completed", text: `done-${name}` });
      const data = readStableFixtureCapture<{ messages: Array<{ id?: unknown; result?: unknown }> }>(cap);
      return { promptedTitles, results: Object.fromEntries(data.messages.filter((m) => typeof m.id === "string").map((m) => [m.id, m.result])) };
    };

    const autoEdit = await runScenario("auto-edit", "auto-edit", false);
    expect(autoEdit.results["m-direct"]).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(autoEdit.results["m-proxied"]).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(autoEdit.results["m-spoof-cmd"]).toEqual({ outcome: { outcome: "selected", optionId: "deny1" } });
    expect(autoEdit.results["m-other-srv"]).toEqual({ outcome: { outcome: "selected", optionId: "deny1" } });
    expect(autoEdit.promptedTitles).toEqual(["curl evil.test", "MCP Tool read_chat?"]);

    const supervised = await runScenario("supervised", "supervised", false);
    expect(supervised.promptedTitles).toHaveLength(4);
    expect(supervised.results["m-direct"]).toEqual({ outcome: { outcome: "selected", optionId: "deny1" } });

    const watcher = await runScenario("watcher", "supervised", true);
    expect(watcher.promptedTitles).toHaveLength(4);
    expect(watcher.results["m-direct"]).toEqual({ outcome: { outcome: "selected", optionId: "deny1" } });
  });

  it("sets AGY_CLI_DISABLE_AUTO_UPDATE=true in child & auth environments and maps -32603 no-browser and SUBSCRIPTION_REQUIRED", async () => {
    const root = makeRoot("antigravity ACP env and errors");
    expect(providerAuthLaunchEnvironment("antigravity", { PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    });

    // 1. Verify AGY_CLI_DISABLE_AUTO_UPDATE="true" reaches spawned child process
    const envFile = join(root, "child-env.json");
    const envCmd = writeFakeAgy(root, null, `
      fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ disableAutoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE }));
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agy-env", modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)}, configOptions: [] } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-env", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Env ok" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);
    const envResult = await managerFor(envCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-env",
      cwd: root,
      prompt: "Check env",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(envResult).toMatchObject({ status: "completed", text: "Env ok" });
    expect(readStableFixtureCapture<{ disableAutoUpdate?: string }>(envFile)).toEqual({
      disableAutoUpdate: "true",
    });

    // 2. -32603 "No browser is available here" -> phase: "auth"
    const noBrowserCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "No browser is available here. Run agy --login." } });
    `);
    const noBrowserResult = await managerFor(noBrowserCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-no-browser",
      cwd: root,
      prompt: "Hello",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(noBrowserResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      error: "Antigravity is not authenticated. Connect Antigravity in provider settings, then try again.",
      failure: {
        reason: "provider-error",
        phase: "auth",
      },
    });

    // 3. SUBSCRIPTION_REQUIRED -> clear subscription message
    const subCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error", data: { details: "SUBSCRIPTION_REQUIRED: account not eligible" } } });
    `);
    const subResult = await managerFor(subCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-sub",
      cwd: root,
      prompt: "Hello",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(subResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      error: "Google requires an eligible Antigravity subscription for this account.",
      failure: {
        reason: "provider-error",
        message: "Google requires an eligible Antigravity subscription for this account.",
      },
    });
  });

  it("fails closed when Supervised or Auto-edit mode cannot be confirmed or when already-in-mode names a different mode", async () => {
    const root = makeRoot("antigravity ACP mode confirmation");

    // 1. Server only offers auto mode: Supervised and Auto-edit must fail closed before session/prompt.
    const autoOnlyCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-auto-only",
        modes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "Auto" }] },
        configOptions: [],
      } });
      if (message.method === "session/prompt") throw new Error("Prompt must not run without confirming requested mode.");
    `);
    for (const [access, expectedMode] of [["supervised", "default"], ["auto-edit", "accept-edits"]] as const) {
      const result = await managerFor(autoOnlyCmd).run(nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: `agy-missing-${access}`,
        cwd: root,
        prompt: "Do not run in auto",
        interactionMode: "build",
        access,
      }));
      expect(result).toMatchObject({
        status: "failed",
        cleanupConfirmed: true,
        error: expect.stringContaining(`required '${expectedMode}' mode`),
      });
    }

    // 2. "already in auto mode" must NOT satisfy a Supervised ("default") mode request.
    const wrongAlreadyCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-wrong-already",
        modes: ${JSON.stringify(DEFAULT_MODES)},
        configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "already in auto mode" } });
      if (message.method === "session/prompt") throw new Error("Prompt must not run when already-in-mode names auto.");
    `);
    const wrongAlreadyResult = await managerFor(wrongAlreadyCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-wrong-already",
      cwd: root,
      prompt: "Check already-in-mode",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(wrongAlreadyResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
    });

    // 3. "already in default mode" DOES satisfy a Supervised ("default") mode request.
    const rightAlreadyCmd = writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-right-already",
        modes: ${JSON.stringify(DEFAULT_MODES)},
        configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "already in default mode" } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-right-already", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Mode confirmed" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);
    const rightAlreadyResult = await managerFor(rightAlreadyCmd).run(nativeProviderRunInput({
      providerId: "antigravity",
      conversationId: "agy-right-already",
      cwd: root,
      prompt: "Check matching already-in-mode",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(rightAlreadyResult).toMatchObject({
      status: "completed",
      text: "Mode confirmed",
      cleanupConfirmed: true,
    });
  });

  it("fails closed with protocol-overflow and terminates the process when approval or input budgets are exceeded", async () => {
    const root = makeRoot("antigravity ACP approval overflow");
    const floodCmd = (prefix: string) => writeFakeAgy(root, null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "agy-flood",
        modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)},
        configOptions: [],
      } });
      if (message.method === "session/prompt") {
        for (let i = 1; i <= 65; i += 1) {
          send({
            jsonrpc: "2.0",
            id: 1000 + i,
            method: "session/request_permission",
            params: {
              sessionId: "agy-flood",
              toolCall: { toolCallId: "${prefix}" + i, title: "Request " + i, kind: "execute" },
              options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
            },
          });
        }
        setTimeout(() => {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-flood", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Completed despite overflow" } } } });
          send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        }, 100);
      }
    `);
    for (const prefix of ["call_", "interaction_"]) {
      const result = await managerFor(floodCmd(prefix)).run(nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: `agy-flood-${prefix}`,
        cwd: root,
        prompt: "Flood",
        interactionMode: "build",
        access: "supervised",
      }));
      expect(result).toMatchObject({
        status: "failed",
        cleanupConfirmed: true,
        failure: {
          reason: "protocol-overflow",
          terminalEvent: "transport/frame",
        },
      });
    }
  });

  it("rejects empty or control-character session IDs from session/new before emitting session events", async () => {
    const root = makeRoot("antigravity ACP invalid session id");
    for (const badId of ["", "bad\u0000id"]) {
      const events: ProviderEvent[] = [];
      const badSessionCmd = writeFakeAgy(root, null, `
        if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initReply({})} });
        if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
          sessionId: ${JSON.stringify(badId)},
          modes: ${JSON.stringify(CONFIRMED_DEFAULT_MODE)},
          configOptions: [],
        } });
      `);
      const result = await managerFor(badSessionCmd).run(nativeProviderRunInput({
        providerId: "antigravity",
        conversationId: `agy-bad-session-${badId.length}`,
        cwd: root,
        prompt: "Hello",
        interactionMode: "build",
        access: "supervised",
      }), { onEvent: (event) => events.push(event) });
      expect(result).toMatchObject({
        status: "failed",
        cleanupConfirmed: true,
        failure: { reason: "malformed-protocol" },
      });
      expect(events.some((event) => event.type === "session")).toBe(false);
    }
  });
});
