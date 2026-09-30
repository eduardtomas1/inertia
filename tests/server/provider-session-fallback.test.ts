// @inertia-test-suite portable
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentHarness,
  AgentHarnessEvent,
  AgentHarnessRun,
  AgentHarnessStartOptions,
} from "../../src/server/provider/agent-harness";
import { isStaleResumeError } from "../../src/server/codex/app-server-config";
import {
  providerRunTerminal,
  type ProviderEvent,
  type ProviderRunFailure,
  type ProviderRunResult,
} from "../../src/server/provider/contracts";
import { cursorRuntimeFailure } from "../../src/server/provider/cursor-acp-failures";
import { startHarnessWithFreshSessionFallback } from "../../src/server/provider/fresh-session-fallback";
import { kimiRuntimeFailure } from "../../src/server/provider/kimi-acp-support";
import {
  acpSessionUnavailable,
  openCodeSessionUnavailable,
} from "../../src/server/provider/session-unavailable";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  captured,
  fakeAppServer as createFakeAppServer,
} from "../helpers/codex-app-server-fixture";
import { lifecycleServerSource } from "../helpers/opencode-lifecycle-server";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const unavailable: ProviderRunFailure = {
  reason: "provider-error",
  message: "The saved session is gone.",
  sessionUnavailable: true,
};

function input(sessionId: string | undefined = "saved-session") {
  return nativeProviderRunInput({
    providerId: "codex",
    conversationId: "fallback-conversation",
    cwd: process.cwd(),
    prompt: "Original prompt",
    interactionMode: "build",
    access: "supervised",
    ...(sessionId ? { sessionId } : {}),
    goalContinuationExpected: true,
  });
}

interface Attempt {
  options: AgentHarnessStartOptions;
  cancelled: boolean[];
  emit(event: Pick<AgentHarnessEvent, "type"> & Record<string, unknown>): void;
  finish(result: Partial<ProviderRunResult>): void;
}

function scriptedHarness(): { harness: AgentHarness; attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  const harness = {
    id: "codex-app-server",
    providerId: "codex",
    capabilities: {} as AgentHarness["capabilities"],
    supports: () => true,
    start: (options: AgentHarnessStartOptions): AgentHarnessRun => {
      let resolve!: (result: ProviderRunResult) => void;
      const cancelled: boolean[] = [];
      const ordinal = attempts.length + 1;
      attempts.push({
        options,
        cancelled,
        emit: (event) => options.callbacks?.onEvent?.({
          providerId: "codex",
          conversationId: options.input.conversationId,
          runId: options.input.runId,
          turnId: options.input.turnId,
          ...event,
        } as AgentHarnessEvent),
        finish: (result) => {
          const status = result.status ?? "completed";
          resolve({
            ...providerRunTerminal(options.input, status, result.failure),
            text: "",
            textTruncated: false,
            exitCode: 0,
            signal: null,
            cleanupConfirmed: true,
            ...result,
          });
        },
      });
      return {
        harnessId: "codex-app-server",
        providerId: "codex",
        result: new Promise((done) => { resolve = done; }),
        cancel: (force) => { cancelled.push(force); },
        extension: { kind: "cli", providerId: "codex", attempt: ordinal } as AgentHarnessRun["extension"],
      };
    },
  } satisfies AgentHarness;
  return { harness, attempts };
}

function start(
  fallback: (() => { prompt: string } | null) | undefined,
  runInput = input(),
  environment: NodeJS.ProcessEnv = { PROVIDER_SECRET: "opaque" },
) {
  const events: AgentHarnessEvent[] = [];
  const { harness, attempts } = scriptedHarness();
  const run = startHarnessWithFreshSessionFallback(harness, {
    input: runInput,
    executable: "provider",
    environment,
    providerNativeToolsAvailable: true,
    callbacks: { onEvent: (event) => { events.push(event); } },
  }, fallback);
  const statuses = () => events.flatMap((event) => event.type === "status" ? [event.status] : []);
  return { run, attempts, events, statuses };
}

describe("fresh provider session fallback", () => {
  it("restarts a rejected resume on a fresh session with the replacement prompt", async () => {
    const fallback = vi.fn(() => ({ prompt: "Replacement prompt with restored history" }));
    const { run, attempts, statuses } = start(fallback);
    attempts[0]!.emit({ type: "status", status: "starting" });
    attempts[0]!.emit({ type: "status", status: "running" });
    attempts[0]!.emit({ type: "status", status: "failed", message: "gone" });
    attempts[0]!.finish({ status: "failed", failure: unavailable, error: unavailable.message });
    await vi.waitFor(() => expect(attempts).toHaveLength(2));

    expect(fallback).toHaveBeenCalledOnce();
    expect(attempts[0]!.options.input).toMatchObject({ sessionId: "saved-session", prompt: "Original prompt" });
    expect(attempts[1]!.options.input.prompt).toBe("Replacement prompt with restored history");
    expect(attempts[1]!.options.input).not.toHaveProperty("sessionId");
    expect(attempts[1]!.options.input).not.toHaveProperty("goalContinuationExpected");
    expect(attempts[1]!.options.input).toMatchObject({
      runId: attempts[0]!.options.input.runId,
      turnId: attempts[0]!.options.input.turnId,
      conversationId: "fallback-conversation",
    });
    expect(attempts[1]!.options.environment).toEqual({ PROVIDER_SECRET: "opaque" });

    attempts[1]!.emit({ type: "status", status: "starting" });
    attempts[1]!.emit({ type: "session", sessionId: "fresh-session" });
    attempts[1]!.emit({ type: "status", status: "running" });
    attempts[1]!.emit({ type: "text", text: "Answer" });
    attempts[1]!.emit({ type: "status", status: "completed" });
    expect(run.extension).toMatchObject({ attempt: 2 });
    attempts[1]!.finish({ status: "completed", sessionId: "fresh-session", text: "Answer" });

    await expect(run.result).resolves.toMatchObject({ status: "completed", sessionId: "fresh-session" });
    expect(statuses()).toEqual(["starting", "running", "running", "completed"]);
  });

  it("delivers the withheld terminal status when the first attempt stands", async () => {
    const { run, attempts, statuses } = start(() => null);
    attempts[0]!.emit({ type: "status", status: "starting" });
    attempts[0]!.emit({ type: "status", status: "failed", message: "gone" });
    expect(statuses()).toEqual(["starting"]);
    attempts[0]!.finish({ status: "failed", failure: unavailable });
    await expect(run.result).resolves.toMatchObject({ status: "failed", failure: unavailable });
    expect(attempts).toHaveLength(1);
    expect(statuses()).toEqual(["starting", "failed"]);
  });

  it.each([
    ["an ordinary failure", { status: "failed", failure: { reason: "provider-error", message: "Quota" } }],
    ["unconfirmed cleanup", { status: "failed", failure: unavailable, cleanupConfirmed: false }],
    ["a completed run", { status: "completed" }],
    ["a cancelled run", { status: "cancelled" }],
  ] as const)("keeps %s without asking for a fallback", async (_label, result) => {
    const fallback = vi.fn(() => ({ prompt: "unused" }));
    const { run, attempts } = start(fallback);
    attempts[0]!.finish(result as Partial<ProviderRunResult>);
    await expect(run.result).resolves.toMatchObject({ status: result.status });
    expect(fallback).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(1);
  });

  it("keeps the rejected resume when the fallback cannot be prepared or the run was cancelled", async () => {
    const throwing = start(() => { throw new Error("ledger refused"); });
    throwing.attempts[0]!.finish({ status: "failed", failure: unavailable });
    await expect(throwing.run.result).resolves.toMatchObject({ status: "failed", failure: unavailable });
    expect(throwing.attempts).toHaveLength(1);

    const fallback = vi.fn(() => ({ prompt: "unused" }));
    const cancelled = start(fallback);
    cancelled.run.cancel(true);
    expect(cancelled.attempts[0]!.cancelled).toEqual([true]);
    cancelled.attempts[0]!.finish({ status: "failed", failure: unavailable });
    await expect(cancelled.run.result).resolves.toMatchObject({ status: "failed" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("stops a fresh attempt that was cancelled while it was starting", async () => {
    const { harness, attempts } = scriptedHarness();
    const original = harness.start;
    let run: ReturnType<typeof startHarnessWithFreshSessionFallback> | undefined;
    harness.start = (options) => {
      const started = original(options);
      if (attempts.length === 2) run!.cancel(false);
      return started;
    };
    run = startHarnessWithFreshSessionFallback(harness, {
      input: input(),
      executable: "provider",
      environment: {},
      providerNativeToolsAvailable: true,
    }, () => ({ prompt: "Replacement" }));
    attempts[0]!.finish({ status: "failed", failure: unavailable });
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]!.cancelled).toEqual([false]);
    attempts[1]!.finish({ status: "cancelled" });
    await expect(run.result).resolves.toMatchObject({ status: "cancelled" });
  });

  it("forwards cancellation to the attempt that is running", async () => {
    const { run, attempts } = start(() => ({ prompt: "Replacement" }));
    attempts[0]!.finish({ status: "failed", failure: unavailable });
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    run.cancel(false);
    expect(attempts[0]!.cancelled).toEqual([]);
    expect(attempts[1]!.cancelled).toEqual([false]);
    attempts[1]!.finish({ status: "cancelled" });
    await expect(run.result).resolves.toMatchObject({ status: "cancelled" });
  });

  it("gives the fresh attempt its own copy of the launch environment", async () => {
    const environments: NodeJS.ProcessEnv[] = [];
    const { harness, attempts } = scriptedHarness();
    const original = harness.start;
    harness.start = (options) => {
      environments.push({ ...options.environment });
      const run = original(options);
      for (const key of Object.keys(options.environment)) delete options.environment[key];
      return run;
    };
    const environment = { PROVIDER_SECRET: "opaque" };
    const run = startHarnessWithFreshSessionFallback(harness, {
      input: input(),
      executable: "provider",
      environment,
      providerNativeToolsAvailable: true,
    }, () => ({ prompt: "Replacement" }));
    attempts[0]!.finish({ status: "failed", failure: unavailable });
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    expect(environments).toEqual([{ PROVIDER_SECRET: "opaque" }, { PROVIDER_SECRET: "opaque" }]);
    expect(attempts[1]!.options.environment).not.toBe(environment);
    attempts[1]!.finish({ status: "completed" });
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
  });

  it.each([
    ["no fallback", undefined, input()],
    ["no saved session", () => ({ prompt: "unused" }), input("")],
    ["a control operation", () => ({ prompt: "unused" }), { ...input(), operation: { kind: "compact" as const } }],
    ["a native goal launch", () => ({ prompt: "unused" }), { ...input(), goalStart: { objective: "Ship" } }],
  ] as const)("starts the harness directly with %s", async (_label, fallback, runInput) => {
    const { run, attempts, statuses } = start(fallback, runInput);
    attempts[0]!.emit({ type: "status", status: "failed" });
    expect(statuses()).toEqual(["failed"]);
    attempts[0]!.finish({ status: "failed", failure: unavailable });
    await expect(run.result).resolves.toMatchObject({ status: "failed" });
    expect(attempts).toHaveLength(1);
  });
});

describe("unavailable session classification", () => {
  it("recognises the errors Codex reports for a thread it no longer has", () => {
    for (const message of [
      "thread not found",
      "no rollout found for thread id 019f0c7d-1111-7222-8333-444455556666",
      "Unknown thread",
      "thread does not exist",
    ]) expect(isStaleResumeError(new Error(message))).toBe(true);
    for (const message of ["rollout not found", "thread is busy", "model not found"]) {
      expect(isStaleResumeError(new Error(message))).toBe(false);
    }
  });

  it("limits ACP detection to a rejected session load or resume", () => {
    expect(acpSessionUnavailable("session/load", "Session not found: abc")).toBe(true);
    expect(acpSessionUnavailable("session/resume", "Resource not found")).toBe(true);
    expect(acpSessionUnavailable("session/load", "unknown session abc")).toBe(true);
    expect(acpSessionUnavailable("session/load", "Authentication required")).toBe(false);
    expect(acpSessionUnavailable("session/load", "Workspace not found")).toBe(false);
    expect(acpSessionUnavailable("session/load", "cwd does not exist")).toBe(false);
    expect(acpSessionUnavailable("session/load", "command not found")).toBe(false);
    expect(acpSessionUnavailable("session/load", "This Cursor ACP server does not advertise session resume support.")).toBe(true);
    expect(acpSessionUnavailable("session/load", "This Kimi ACP server does not advertise session resume support.")).toBe(true);
    expect(acpSessionUnavailable("initialize", "This Kimi ACP server does not advertise session resume support.")).toBe(false);
    expect(acpSessionUnavailable("session/new", "Session not found")).toBe(false);
    expect(acpSessionUnavailable("session/prompt", "File not found")).toBe(false);
  });

  it("marks only a provider-rejected Cursor or Kimi session load", () => {
    const child = { exitCode: null, signalCode: null } as never;
    expect(cursorRuntimeFailure("Session not found", child, "session", "session/load"))
      .toMatchObject({ reason: "provider-error", sessionUnavailable: true });
    expect(cursorRuntimeFailure("Session not found", child, "turn", "session/prompt"))
      .not.toHaveProperty("sessionUnavailable");
    expect(cursorRuntimeFailure("session/load timed out: not found", child, "session", "session/load"))
      .not.toHaveProperty("sessionUnavailable");
    expect(cursorRuntimeFailure(
      "Session not found",
      { exitCode: 1, signalCode: null } as never,
      "session",
      "session/load",
    )).not.toHaveProperty("sessionUnavailable");

    const context = { child, phase: "session", workspaceRoot: process.cwd(), diagnostic: "" };
    expect(kimiRuntimeFailure(new Error("Session not found"), { ...context, terminalEvent: "session/resume" }))
      .toMatchObject({ sessionUnavailable: true });
    expect(kimiRuntimeFailure(new Error("Session not found"), {
      ...context,
      terminalEvent: "session/resume",
      wireError: new Error("Kimi ACP stream closed"),
    })).toMatchObject({ sessionUnavailable: true });
    expect(kimiRuntimeFailure(new Error("Kimi ACP stream closed"), { ...context, terminalEvent: "session/resume" }))
      .not.toHaveProperty("sessionUnavailable");
    expect(kimiRuntimeFailure(new Error("Session not found"), { ...context, terminalEvent: "session/load" }))
      .toMatchObject({ sessionUnavailable: true });
    expect(kimiRuntimeFailure(new Error("auth_required: session not found"), { ...context, terminalEvent: "session/load" }))
      .not.toHaveProperty("sessionUnavailable");
    expect(kimiRuntimeFailure(new Error("Session not found"), { ...context, terminalEvent: "session/new" }))
      .not.toHaveProperty("sessionUnavailable");
    expect(kimiRuntimeFailure(new Error("Tool failed"), {
      ...context,
      terminalEvent: "session/load",
      diagnostic: "stderr: config file not found",
    })).not.toHaveProperty("sessionUnavailable");
  });

  it("recognises OpenCode's missing-session response", () => {
    expect(openCodeSessionUnavailable({
      name: "NotFoundError",
      data: { message: "Session not found: ses_0000000000000000000000000" },
    })).toBe(true);
    expect(openCodeSessionUnavailable(new Error("Session not found: ses_1"))).toBe(true);
    expect(openCodeSessionUnavailable({ name: "UnknownError", data: { message: "Provider unavailable" } })).toBe(false);
    expect(openCodeSessionUnavailable("Session not found")).toBe(false);
    expect(openCodeSessionUnavailable(null)).toBe(false);
  });
});

describe("Codex App Server session fallback", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const originalCapturePath = process.env.INERTIA_APP_SERVER_CAPTURE;
  const originalScenario = process.env.INERTIA_APP_SERVER_SCENARIO;

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    if (originalCapturePath === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
    else process.env.INERTIA_APP_SERVER_CAPTURE = originalCapturePath;
    if (originalScenario === undefined) delete process.env.INERTIA_APP_SERVER_SCENARIO;
    else process.env.INERTIA_APP_SERVER_SCENARIO = originalScenario;
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function fixture(scenario: string) {
    const fake = createFakeAppServer(roots);
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = scenario;
    const manager = ProviderManager.createForTests({
      commands: { codex: fake.command },
      resolveBackendLaunchOptions: (_input, environment) => ({
        environment: {
          ...environment,
          INERTIA_APP_SERVER_CAPTURE: fake.capturePath,
          INERTIA_APP_SERVER_SCENARIO: scenario,
        },
      }),
    });
    managers.push(manager);
    const runInput = nativeProviderRunInput({
      providerId: "codex",
      conversationId: `conversation-${scenario}`,
      cwd: fake.root,
      prompt: "Continue from the saved thread.",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-saved",
    });
    return { fake, manager, runInput };
  }

  it.each(["stale-resume", "missing-rollout-resume"])("reports a %s as an unavailable session", async (scenario) => {
    const { fake, manager, runInput } = fixture(scenario);
    await expect(manager.run(runInput)).resolves.toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      error: expect.stringContaining("saved provider session is no longer available"),
      failure: { sessionUnavailable: true },
    });
    const messages = captured(fake.capturePath);
    expect(messages.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
    expect(messages.some(({ method }) => method === "thread/start")).toBe(false);
    expect(messages.some(({ method }) => method === "turn/start")).toBe(false);
  });

  it.each(["stale-resume", "missing-rollout-resume"])("answers a %s from a fresh thread in the same run", async (scenario) => {
    const { fake, manager, runInput } = fixture(scenario);
    const events: ProviderEvent[] = [];
    const fallback = vi.fn(() => ({ prompt: "Continue with the restored history." }));
    const result = await manager.run(runInput, {
      onEvent: (event) => { events.push(event); },
      freshSessionFallback: fallback,
    });
    expect(result).toMatchObject({ status: "completed", sessionId: "thread-new", cleanupConfirmed: true });
    expect(fallback).toHaveBeenCalledOnce();
    const messages = captured(fake.capturePath);
    expect(messages.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
    expect(messages.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    const turns = messages.filter(({ method }) => method === "turn/start");
    expect(turns).toHaveLength(1);
    expect(JSON.stringify(turns[0])).toContain("Continue with the restored history.");
    expect(JSON.stringify(turns[0])).not.toContain("Continue from the saved thread.");
    expect(events.flatMap((event) => event.type === "session" ? [event.sessionId] : [])).toEqual(["thread-new"]);
    expect(events.some((event) => event.type === "status" && event.status === "failed")).toBe(false);
    expect(manager.isRunning(runInput.conversationId)).toBe(false);
  });

  it("keeps the failed resume when the turn declines the fallback", async () => {
    const { fake, manager, runInput } = fixture("missing-rollout-resume");
    const result = await manager.run(runInput, { freshSessionFallback: () => null });
    expect(result).toMatchObject({ status: "failed", failure: { sessionUnavailable: true } });
    expect(captured(fake.capturePath).some(({ method }) => method === "thread/start")).toBe(false);
  });
});

describe("OpenCode session fallback", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function fixture(label: string) {
    const root = portableFixtureRoot(label);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "resume"));
    const manager = ProviderManager.createForTests(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    managers.push(manager);
    const runInput = nativeProviderRunInput({
      providerId: "opencode",
      conversationId: label.replaceAll(" ", "-"),
      cwd: root,
      prompt: "Continue from the saved session.",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-missing-session",
    });
    const requests = () => (JSON.parse(readFileSync(capturePath, "utf8")) as {
      captured: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
    }).captured;
    return { manager, runInput, requests };
  }

  it("reports a session the server no longer has as unavailable", async () => {
    const { manager, runInput, requests } = fixture("OpenCode missing session");
    await expect(manager.run(runInput)).resolves.toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { sessionUnavailable: true },
    });
    expect(requests().some(({ method, path }) => method === "GET" && path === "/session/opencode-missing-session")).toBe(true);
    expect(requests().some(({ method, path }) => method === "POST" && path === "/session")).toBe(false);
  });

  it("reports a server that answers with a different session as unavailable", async () => {
    const root = portableFixtureRoot("OpenCode mismatched session");
    roots.push(root);
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(
      root,
      join(root, "capture.json"),
      "resume",
      0,
      "opencode-other-session",
    ));
    const manager = ProviderManager.createForTests(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    managers.push(manager);
    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-mismatched-session",
      cwd: root,
      prompt: "Continue.",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { sessionUnavailable: true },
    });
  });

  it("answers from a new session when the saved one is missing", async () => {
    const { manager, runInput, requests } = fixture("OpenCode session fallback");
    const sessions: string[] = [];
    const fallback = vi.fn(() => ({ prompt: "Continue with the restored history." }));
    const result = await manager.run(runInput, {
      onSession: (event) => { sessions.push(event.sessionId); },
      freshSessionFallback: fallback,
    });
    expect(result).toMatchObject({
      status: "completed",
      sessionId: "opencode-lifecycle-session",
      text: "Resumed OpenCode response",
      cleanupConfirmed: true,
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(sessions).toEqual(["opencode-lifecycle-session"]);
    const fresh = requests();
    expect(fresh.some(({ method, path }) => method === "POST" && path === "/session")).toBe(true);
    expect(fresh.some(({ path }) => path === "/session/opencode-missing-session")).toBe(false);
    const prompt = fresh.find(({ path }) => path === "/session/opencode-lifecycle-session/prompt_async");
    expect(JSON.stringify(prompt?.body)).toContain("Continue with the restored history.");
    expect(JSON.stringify(prompt?.body)).not.toContain("Continue from the saved session.");
  });
});

describe.each([
  ["cursor", "cursor-agent", "Cursor", { loadSession: true }, "session/load"],
  ["kimi", "kimi", "Kimi Code CLI", { loadSession: true, sessionCapabilities: { resume: {} } }, "session/resume"],
] as const)("%s ACP session fallback", (providerId, executable, agentName, agentCapabilities, resumeMethod) => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function fixture(label: string, capabilities: Record<string, unknown> = agentCapabilities) {
    const root = portableFixtureRoot(label);
    roots.push(root);
    const capturePath = join(root, "capture.jsonl");
    const command = portableNodeExecutable(root, executable);
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const modes = { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] };
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: ${JSON.stringify(capabilities)}, agentInfo: { name: ${JSON.stringify(agentName)}, version: "test" } } });
  if (message.method === ${JSON.stringify(resumeMethod)}) return send({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Session not found: " + message.params.sessionId } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fresh-acp-session", modes, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answered from a fresh session" } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = ProviderManager.createForTests(
      { commands: { [providerId]: command } },
      new AgentHarnessRegistry([providerId === "cursor" ? createCursorAcpHarness() : createKimiAcpHarness()]),
    );
    managers.push(manager);
    const runInput = nativeProviderRunInput({
      providerId,
      conversationId: label.replaceAll(" ", "-"),
      cwd: root,
      prompt: "Continue from the saved session.",
      interactionMode: "build",
      access: "supervised",
      sessionId: "saved-acp-session",
    });
    const requests = () => readFileSync(capturePath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    return { manager, runInput, requests };
  }

  it("reports a rejected session as unavailable", async () => {
    const { manager, runInput, requests } = fixture(`${providerId} ACP missing session`);
    await expect(manager.run(runInput)).resolves.toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { sessionUnavailable: true },
    });
    expect(requests().filter(({ method }) => method === resumeMethod)).toHaveLength(1);
    expect(requests().some(({ method }) => method === "session/new")).toBe(false);
  });

  it("reports a server without session resume as unavailable at the session step", async () => {
    const { manager, runInput, requests } = fixture(`${providerId} ACP without resume`, {});
    await expect(manager.run(runInput)).resolves.toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { sessionUnavailable: true },
    });
    expect(requests().some(({ method }) => method === resumeMethod || method === "session/new")).toBe(false);
  });

  it("answers from a new session when the saved one is rejected", async () => {
    const { manager, runInput, requests } = fixture(`${providerId} ACP session fallback`);
    const sessions: string[] = [];
    const result = await manager.run(runInput, {
      onSession: (event) => { sessions.push(event.sessionId); },
      freshSessionFallback: () => ({ prompt: "Continue with the restored history." }),
    });
    expect(result).toMatchObject({
      status: "completed",
      sessionId: "fresh-acp-session",
      text: "Answered from a fresh session",
      cleanupConfirmed: true,
    });
    expect(sessions).toEqual(["fresh-acp-session"]);
    const recorded = requests();
    expect(recorded.filter(({ method }) => method === resumeMethod)).toHaveLength(1);
    expect(recorded.filter(({ method }) => method === "session/new")).toHaveLength(1);
    const prompts = recorded.filter(({ method }) => method === "session/prompt");
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0]!.params)).toContain("Continue with the restored history.");
    expect(JSON.stringify(prompts[0]!.params)).not.toContain("Continue from the saved session.");
  });
});
