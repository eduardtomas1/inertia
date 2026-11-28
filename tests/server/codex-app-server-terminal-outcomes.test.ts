// @inertia-test-suite portable
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawning = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: spawning.spawn,
}));
vi.mock("../../src/server/codex-app-server", async (original) => {
  const actual = await original<typeof import("../../src/server/codex-app-server")>();
  return {
    ...actual,
    startCodexAppServerRun: (options: Parameters<typeof actual.startCodexAppServerRun>[0]) =>
      actual.startCodexAppServerRun({ ...options, terminateProcessTree: spawning.terminate }),
  };
});

import { startCodexAppServerRun } from "../../src/server/codex/app-server-run";
import { createCodexAppServerHarness } from "../../src/server/provider/codex-app-server-harness";
import { redactCodexErrorHeaders } from "../../src/server/codex/managed-errors";
import { nativeProviderRunInput } from "./model-route-fixture";

function fixture(throughHarness = false, heldMethods: readonly string[] = []) {
  const observed = { onActivity: vi.fn(), onText: vi.fn(), onStatus: vi.fn(), onRateLimits: vi.fn(), onSubagent: vi.fn() };
  const writes: unknown[] = [];
  const held = new Map<string, number>();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk)) as { id?: number; method?: string };
      writes.push(message);
      if (message.id !== undefined && message.method && heldMethods.includes(message.method)) {
        held.set(message.method, message.id);
      } else if (message.id !== undefined && message.method) {
        const result = message.method === "thread/start"
          ? { thread: { id: "thread-test" } }
          : message.method === "turn/start" ? { turn: { id: "turn-test" } } : {};
        stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
      callback();
    },
  });
  Object.assign(child, {
    pid: 424242, exitCode: null, signalCode: null,
    stdin, stdout, stderr, stdio: [stdin, stdout, stderr],
  });
  spawning.spawn.mockReturnValue(child);
  let finishCleanup!: (confirmed: boolean) => void;
  const cleanup = new Promise<boolean>((resolve) => { finishCleanup = resolve; });
  const terminateProcessTree = vi.fn(() => cleanup);
  spawning.terminate.mockImplementation(terminateProcessTree);
  const run = throughHarness ? createCodexAppServerHarness().start({
    executable: "/synthetic/codex", environment: {},
    providerNativeToolsAvailable: true,
    input: nativeProviderRunInput({
      providerId: "codex", conversationId: "terminal-outcome-test",
      cwd: "/synthetic", prompt: "Exercise terminal outcomes",
      access: "full", interactionMode: "build",
    }),
  }) : startCodexAppServerRun({
    executable: "/synthetic/codex", cwd: "/synthetic", environment: {},
    prompt: "Exercise terminal outcomes", access: "full", planMode: false,
    rpcTimeoutMs: 50, terminateProcessTree,
    ...observed,
  });
  child.emit("spawn");
  return {
    run, terminateProcessTree, finishCleanup, observed, writes,
    notification(method: string, params: Record<string, unknown>) {
      stdout.write(`${JSON.stringify({ method, params })}\n`);
    },
    respond(method: string, result: Record<string, unknown>) {
      stdout.write(`${JSON.stringify({ id: held.get(method), result })}\n`);
    },
    spawnLiveChild() {
      stdout.write(`${JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-test", turnId: "turn-test",
          item: {
            id: "spawn-child", type: "collabAgentToolCall", tool: "spawnAgent", status: "inProgress",
            senderThreadId: "thread-test", receiverThreadIds: ["child-thread"], prompt: "Verify the result",
            agentsStates: { "child-thread": { status: "running", message: "Still verifying" } },
          },
        },
      })}\n`);
      stdout.write(`${JSON.stringify({
        method: "turn/started",
        params: { threadId: "child-thread", turn: { id: "child-turn", status: "inProgress", items: [], error: null } },
      })}\n`);
    },
    serverRequest(method: string, params: Record<string, unknown>) {
      stdout.write(`${JSON.stringify({ id: "review-request", method, params })}\n`);
    },
    unsafeInputRequest(kind: "foreign-turn" | "malformed") {
      stdout.write(`${JSON.stringify({
        id: "unsafe-input", method: "item/tool/requestUserInput",
        params: kind === "malformed" ? {} : {
          threadId: "thread-test", turnId: "foreign-turn", itemId: "unsafe-item",
          questions: [{
            id: "choice", header: "Direction", question: "Which path?",
            options: [{ label: "Safe", description: "Use the bounded path." }],
          }],
        },
      })}\n`);
    },
    malformedFrame() {
      stdout.write("{invalid-json}\n");
    },
    providerError() {
      stdout.write(`${JSON.stringify({
        method: "error",
        params: {
          threadId: "thread-test", turnId: "turn-test", willRetry: false,
          error: { message: "Provider rejected the operation." },
        },
      })}\n`);
    },
    inputRequest(id: string) {
      stdout.write(`${JSON.stringify({
        id, method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-test", turnId: "turn-test", itemId: id,
          questions: [{
            id: "choice", header: "Direction", question: "Which path?",
            options: [{ label: "Safe", description: "Use the bounded path." }],
          }],
        },
      })}\n`);
    },
    malformedDelegation() {
      stdout.write(`${JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-test", turnId: "turn-test",
          item: {
            id: "bad-spawn", type: "collabAgentToolCall", tool: "spawnAgent",
            senderThreadId: "thread-test", receiverThreadIds: [null],
          },
        },
      })}\n`);
    },
    terminal(status: string, error: unknown = null, threadId = "thread-test", turnId = "turn-test") {
      stdout.write(`${JSON.stringify({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turnId, status, items: [], error },
        },
      })}\n`);
    },
  };
}

const GUARDIAN_MESSAGE = "Codex stopped the turn after repeated approval denials.";
const GUARDIAN_ERROR = {
  message: "Guardian interrupted the turn after 3 consecutive approval denials.",
  codexErrorInfo: "tooManyDenials",
  additionalDetails: null,
};

function activeGoal(updatedAt: number) {
  return {
    threadId: "thread-test", objective: "Finish the guarded goal", status: "active",
    tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1_800_000_000, updatedAt,
  };
}

async function expectGuardianFailure(app: ReturnType<typeof fixture>) {
  const result = await app.run.result;
  expect(result).toMatchObject({
    status: "failed", cleanupConfirmed: true,
    failure: { reason: "codex-error", message: GUARDIAN_MESSAGE, terminalEvent: "turn/completed" },
  });
  expect(result.failure?.technicalDetail).toContain("Codex error: tooManyDenials");
  expect(app.terminateProcessTree).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  return result;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("Codex App Server terminal outcomes", () => {
  it.each([false, true])("reports a Guardian circuit-breaker interruption as failure through the public harness: %s", async (throughHarness) => {
    const app = fixture(throughHarness);
    await vi.advanceTimersByTimeAsync(0);
    // Codex 0.159 carries this error only on turn/completed, with no error notification.
    app.terminal("interrupted", GUARDIAN_ERROR);
    app.finishCleanup(true);

    await expectGuardianFailure(app);
    if (!throughHarness) expect(app.observed.onActivity).toHaveBeenCalledWith(
      "turn", "failed", "Turn interrupted by Codex", expect.any(Object),
    );
  });

  it("names the Guardian cause without an error message", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("interrupted", { message: null, codexErrorInfo: "tooManyDenials" });
    app.finishCleanup(true);

    await expectGuardianFailure(app);
  });

  it("reports the Guardian provider message once in the technical detail", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("interrupted", GUARDIAN_ERROR);
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result.failure?.technicalDetail?.split(GUARDIAN_ERROR.message)).toHaveLength(2);
    await expectGuardianFailure(app);
  });

  it.each([
    { message: "A provider policy interrupted this turn." },
    { message: { invalid: true }, additionalDetails: { private: "UNEXPECTED_PAYLOAD" } },
    {},
    { unexpected: "UNEXPECTED_PAYLOAD", nested: { private: "UNEXPECTED_PAYLOAD" } },
  ])("safely fails an interrupted turn with an explicit provider error object: %j", async (error) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("interrupted", error);
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true, failure: { reason: "codex-error" } });
    expect(result.failure?.message).toBe("Codex interrupted the turn before completion.");
    expect(JSON.stringify(result)).not.toContain("UNEXPECTED_PAYLOAD");
    expect(app.terminateProcessTree).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[[]], ["UNEXPECTED_PAYLOAD"]])(
    "keeps an interrupted turn with a non-object error %j cancelled",
    async (error) => {
      const app = fixture();
      await vi.advanceTimersByTimeAsync(0);
      app.terminal("interrupted", error);
      app.finishCleanup(true);

      const result = await app.run.result;
      expect(result).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
      expect(result.failure).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("UNEXPECTED_PAYLOAD");
      expect(app.terminateProcessTree).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["contextWindowExceeded", "contextWindowExceeded"],
    [{ httpConnectionFailed: { httpStatusCode: 502 } }, "httpConnectionFailed"],
  ] as const)("keeps the sanitised Codex error %j for another interruption cause", async (codexErrorInfo, name) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("interrupted", { message: "Codex interrupted the turn.", codexErrorInfo });
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result).toMatchObject({ status: "failed", failure: { reason: "codex-error" } });
    expect(result.failure?.message).toBe("Codex interrupted the turn before completion.");
    expect(result.failure?.technicalDetail).toContain(`Codex error: ${name}`);
    expect(result.failure?.technicalDetail).not.toContain("502");
    expect(app.terminateProcessTree).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "UNEXPECTED PAYLOAD with spaces",
    { first: {}, second: {} },
    `x${"y".repeat(64)}`,
  ])("drops an unrecognised Codex error shape %j from the technical detail", async (codexErrorInfo) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("interrupted", { message: "Codex interrupted the turn.", codexErrorInfo });
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result).toMatchObject({ status: "failed", failure: { reason: "codex-error" } });
    expect(result.failure?.technicalDetail).not.toContain("Codex error:");
    expect(app.terminateProcessTree).toHaveBeenCalledOnce();
  });

  it("bounds and scrubs the provider interruption diagnostic", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("interrupted", {
      message: `\0Guardian interrupted the turn. token=PRIVATE_DIAGNOSTIC_TOKEN ${"x".repeat(5_000)} OVER_LIMIT`,
      codexErrorInfo: "tooManyDenials",
      additionalDetails: "UNEXPECTED_PAYLOAD",
    });
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result).toMatchObject({ status: "failed", failure: { reason: "codex-error" } });
    expect(result.failure?.technicalDetail).toContain("Guardian interrupted the turn.");
    expect(result.failure?.technicalDetail).toContain("tooManyDenials");
    expect(result.failure?.technicalDetail).not.toMatch(/PRIVATE_DIAGNOSTIC_TOKEN|OVER_LIMIT|UNEXPECTED_PAYLOAD|\0/u);
    expect(result).toHaveProperty("diagnostic", expect.any(String));
    expect("diagnostic" in result ? result.diagnostic?.length : undefined).toBeLessThanOrEqual(4_000);
  });

  it.each([
    ["a final error notification", true, "usageLimitExceeded", true],
    ["a failed turn", false, "usageLimitExceeded", true],
    ["a final error notification", true, "contextWindowExceeded", false],
    ["a failed turn", false, { httpConnectionFailed: { httpStatusCode: 429 } }, false],
  ] as const)("tags a usage-limit failure only from Codex's structured error info (%s, %j)", async (_label, notified, codexErrorInfo, limited) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    if (notified) {
      app.notification("error", { threadId: "thread-test", turnId: "turn-test", willRetry: false,
        error: { message: "You've hit your usage limit.", codexErrorInfo } });
      app.terminal("failed", { message: "You've hit your usage limit." });
    } else {
      app.terminal("failed", { message: "You've hit your usage limit.", codexErrorInfo });
    }
    app.finishCleanup(true);
    const result = await app.run.result;
    expect(result).toMatchObject({ status: "failed", failure: { reason: "codex-error" } });
    expect(result.failure?.usageLimited).toBe(limited ? true : undefined);
  });

  it("does not tag usage-limit text without Codex's structured error info", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("failed", { message: "You've hit your usage limit. Try again later." });
    app.finishCleanup(true);
    expect((await app.run.result).failure?.usageLimited).toBeUndefined();
  });

  it("keeps a plain interrupted turn cancelled after an earlier retryable provider error", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.notification("error", {
      threadId: "thread-test", turnId: "turn-test", willRetry: true,
      error: { message: "A transient provider failure is being retried." },
    });
    app.terminal("interrupted");
    app.finishCleanup(true);

    expect(await app.run.result).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
    expect((await app.run.result).failure).toBeUndefined();
  });

  it.each(["before", "after"] as const)("preserves cancellation order when user cancellation arrives %s a Guardian interruption", async (when) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    if (when === "before") app.run.cancel(false);
    app.terminal("interrupted", {
      message: "Guardian interrupted the turn after too many approval denials.",
      codexErrorInfo: "tooManyDenials",
    });
    if (when === "after") app.run.cancel(false);
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result.status).toBe(when === "before" ? "cancelled" : "failed");
    if (when === "before") expect(result.failure).toBeUndefined();
    else expect(result.failure?.reason).toBe("codex-error");
  });

  it.each([
    { threadId: "foreign-thread", turnId: "turn-test" },
    { threadId: "thread-test", turnId: "foreign-turn" },
  ])("ignores another turn's provider interruption: %j", async ({ threadId, turnId }) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.notification("turn/completed", {
      threadId,
      turn: { id: turnId, status: "interrupted", items: [], error: { message: "FOREIGN_DIAGNOSTIC", codexErrorInfo: "tooManyDenials" } },
    });
    expect(app.terminateProcessTree).not.toHaveBeenCalled();
    app.terminal("completed");
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result.status).toBe("completed");
    expect(result.failure).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("FOREIGN_DIAGNOSTIC");
  });

  it("fails a Guardian stop while delegated work is still running", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.spawnLiveChild();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.observed.onSubagent).toHaveBeenLastCalledWith(expect.objectContaining({
      providerAgentId: "child-thread", status: "running", isLive: true,
    }));
    app.terminal("interrupted", GUARDIAN_ERROR);
    app.finishCleanup(true);

    await expectGuardianFailure(app);
    expect(app.observed.onStatus).not.toHaveBeenCalledWith("delegated", expect.anything());
  });

  it("fails a delegated child stopped by Guardian and keeps the parent outcome", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.spawnLiveChild();
    app.terminal("interrupted", GUARDIAN_ERROR, "child-thread", "child-turn");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.observed.onSubagent).toHaveBeenLastCalledWith(expect.objectContaining({
      providerAgentId: "child-thread", status: "failed", providerStatus: "interrupted", isLive: false,
      result: `${GUARDIAN_MESSAGE}\n${GUARDIAN_ERROR.message}`,
    }));
    expect(app.terminateProcessTree).not.toHaveBeenCalled();
    app.terminal("completed");
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({ status: "completed", cleanupConfirmed: true });
    expect((await app.run.result).failure).toBeUndefined();
    expect(app.terminateProcessTree).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers a Guardian stop until a pending goal mutation settles", async () => {
    const app = fixture(false, ["thread/goal/set"]);
    await vi.advanceTimersByTimeAsync(0);
    const run = app.run as ReturnType<typeof startCodexAppServerRun>;
    const goal = run.setGoal({ status: "active", objective: "Finish the guarded goal" });
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("interrupted", GUARDIAN_ERROR);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.terminateProcessTree).not.toHaveBeenCalled();
    app.respond("thread/goal/set", { goal: activeGoal(1_800_000_010) });
    await expect(goal).resolves.toMatchObject({ status: "active" });
    app.finishCleanup(true);

    await expectGuardianFailure(app);
  });

  it("fails a Guardian stop on a goal continuation turn", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.notification("thread/goal/updated", { threadId: "thread-test", turnId: "turn-test", goal: activeGoal(1_800_000_010) });
    app.terminal("completed");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    app.notification("turn/started", {
      threadId: "thread-test", turn: { id: "turn-continuation", status: "inProgress", items: [], error: null },
    });
    app.terminal("interrupted", GUARDIAN_ERROR, "thread-test", "turn-continuation");
    app.finishCleanup(true);

    await expectGuardianFailure(app);
  });

  it.each(["started", "failed"])("ignores gateway OAuth %s without projecting auth handoffs or changing the active turn", async (status) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    const before = JSON.stringify({ writes: app.writes, calls: Object.values(app.observed).map((spy) => spy.mock.calls) });
    app.notification("account/gatewayOAuth/changed", {
      providerId: "fixture-gateway", status,
      authUrl: "https://gateway.example.test/authorize?code=PRIVATE_GATEWAY_CODE",
      error: "PRIVATE_GATEWAY_DIAGNOSTIC", threadId: "thread-test", turnId: "turn-test",
    });
    expect(JSON.stringify({ writes: app.writes, calls: Object.values(app.observed).map((spy) => spy.mock.calls) })).toBe(before);
    expect(app.terminateProcessTree).not.toHaveBeenCalled();
    app.terminal("completed"); app.finishCleanup(true);
    const result = await app.run.result;
    expect(result).toMatchObject({ status: "completed", cleanupConfirmed: true });
    expect(JSON.stringify({ result, calls: Object.values(app.observed).map((spy) => spy.mock.calls) })).not.toContain("PRIVATE_GATEWAY");
  });

  it.each([
    { status: "future-secret-status" }, { authUrl: { code: "PRIVATE_GATEWAY_CODE" } },
    { authUrl: "https://gateway.example.test/authorize?code=PRIVATE_GATEWAY_CODE", error: undefined },
  ])("drops an unknown or malformed gateway OAuth status without failing the turn or retaining it: %j", async (override) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    const before = JSON.stringify({ writes: app.writes, calls: Object.values(app.observed).map((spy) => spy.mock.calls) });
    app.notification("account/gatewayOAuth/changed", {
      providerId: "fixture-gateway", status: "started", authUrl: null, error: "PRIVATE_GATEWAY_DIAGNOSTIC", ...override,
    });
    expect(JSON.stringify({ writes: app.writes, calls: Object.values(app.observed).map((spy) => spy.mock.calls) })).toBe(before);
    expect(app.terminateProcessTree).not.toHaveBeenCalled();
    app.terminal("completed"); app.finishCleanup(true);
    const result = await app.run.result;
    expect(result).toMatchObject({ status: "completed", cleanupConfirmed: true });
    expect(result.failure).toBeUndefined();
    expect(JSON.stringify({ result, calls: Object.values(app.observed).map((spy) => spy.mock.calls) })).not.toMatch(/PRIVATE_GATEWAY|future-secret-status/u);
  });

  it.each([
    ["foreign approval", "item/commandExecution/requestApproval", { threadId: "foreign-thread", command: "npm test" }],
    ["malformed approval", "item/commandExecution/requestApproval", { threadId: "thread-test", command: { invalid: true } }],
    ["unsupported decisions", "item/commandExecution/requestApproval", { threadId: "thread-test", availableDecisions: ["acceptForSession"] }],
    ["foreign time request", "currentTime/read", { threadId: "foreign-thread" }],
    ["malformed time request", "currentTime/read", {}],
    ["foreign elicitation", "mcpServer/elicitation/request", { threadId: "thread-test", turnId: "foreign-turn", serverName: "synthetic", mode: "form" }],
    ["malformed elicitation", "mcpServer/elicitation/request", {}],
  ] as const)("classifies rejected %s as provider failure", async (_label, method, params) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.serverRequest(method, params);
    app.terminal("interrupted");
    app.finishCleanup(true);
    await expect(app.run.result).resolves.toMatchObject({
      status: "failed", cleanupConfirmed: true,
      failure: { reason: "malformed-protocol" },
    });
    expect(app.terminateProcessTree).toHaveBeenCalledOnce();
  });

  it.each([undefined, "interrupted", "completed"])(
    "fails malformed delegated-agent output even when cleanup races %s",
    async (racingStatus) => {
      const app = fixture();
      await vi.advanceTimersByTimeAsync(0);
      app.malformedDelegation();
      if (racingStatus) app.terminal(racingStatus);
      await vi.advanceTimersByTimeAsync(0);
      expect(app.terminateProcessTree).toHaveBeenCalledOnce();
      let returned = false;
      void app.run.result.then(() => { returned = true; });
      await Promise.resolve();
      expect(returned).toBe(false);
      app.finishCleanup(true);

      await expect(app.run.result).resolves.toMatchObject({
        status: "failed", cleanupConfirmed: true,
        failure: { reason: "malformed-protocol", phase: "running" },
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("preserves explicit cancellation before malformed delegated-agent output", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.run.cancel(false);
    app.malformedDelegation();
    app.terminal("interrupted");
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({
      status: "cancelled", cleanupConfirmed: true,
    });
    expect((await app.run.result).failure).toBeUndefined();
  });

  it("preserves accepted protocol failure before explicit cancellation", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.malformedDelegation();
    app.run.cancel(false);
    app.terminal("completed");
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({
      status: "failed", cleanupConfirmed: true,
      failure: { reason: "malformed-protocol" },
    });
    expect(app.terminateProcessTree).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reports the failed turn's own error instead of a generic sentence: %s", async (throughHarness) => {
    const app = fixture(throughHarness);
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("failed", { message: "TimeoutError waiting for selector \"#submit\" after 30000ms\nat tests/login.test.ts:88", codexErrorInfo: null, additionalDetails: null });
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "codex-error", message: "TimeoutError waiting for selector \"#submit\" after 30000ms\nat tests/login.test.ts:88" },
    });
  });

  it.each([false, true])("reports an error notification's own message when Codex will not retry: %s", async (throughHarness) => {
    const app = fixture(throughHarness);
    await vi.advanceTimersByTimeAsync(0);
    app.providerError();
    app.terminal("failed");
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({
      status: "failed", failure: { reason: "codex-error", message: "Provider rejected the operation." },
    });
  });

  it("retains the first provider error when malformed output requires stopping", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.providerError();
    app.malformedDelegation();
    app.terminal("interrupted");
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({
      status: "failed", cleanupConfirmed: true,
      failure: { reason: "codex-error" },
    });
  });

  it.each(["duplicate", "overflow"] as const)(
    "fails a %s server request instead of reporting user cancellation",
    async (kind) => {
      const app = fixture();
      await vi.advanceTimersByTimeAsync(0);
      if (kind === "duplicate") {
        app.inputRequest("duplicate");
        app.inputRequest("duplicate");
      } else {
        for (let index = 0; index < 33; index += 1) {
          app.inputRequest(`request-${index}`);
        }
      }
      app.terminal("interrupted");
      app.finishCleanup(true);

      await expect(app.run.result).resolves.toMatchObject({
        status: "failed", cleanupConfirmed: true,
        failure: { reason: "malformed-protocol" },
      });
      expect(app.terminateProcessTree).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("preserves accepted completion before malformed delegated-agent output", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("completed");
    app.malformedDelegation();
    app.run.cancel(false);
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({
      status: "completed", cleanupConfirmed: true,
    });
    expect((await app.run.result).failure).toBeUndefined();
  });

  it("retains cleanup uncertainty after malformed delegated-agent output", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.malformedDelegation();
    await vi.advanceTimersByTimeAsync(0);
    app.finishCleanup(false);

    await expect(app.run.result).resolves.toMatchObject({
      status: "failed", cleanupConfirmed: false,
      failure: { reason: "malformed-protocol" },
    });
  });

  it.each(["failed", "completed"] as const)(
    "preserves accepted %s through the public harness when cancellation arrives during cleanup",
    async (status) => {
      const app = fixture(true);
      await vi.advanceTimersByTimeAsync(0);
      if (status === "failed") app.malformedDelegation();
      else app.terminal("completed");
      app.run.cancel(false);
      app.finishCleanup(true);

      await expect(app.run.result).resolves.toMatchObject({
        status, cleanupConfirmed: true,
      });
    },
  );

  it.each([true, false])(
    "preserves public cancellation before a terminal error whether or not cleanup is confirmed: %s",
    async (cleanupConfirmed) => {
      const app = fixture(true);
      await vi.advanceTimersByTimeAsync(0);
      app.run.cancel(false);
      app.malformedFrame();
      app.finishCleanup(cleanupConfirmed);

      await expect(app.run.result).resolves.toMatchObject({
        status: "cancelled", cleanupConfirmed,
      });
      expect((await app.run.result).failure).toBeUndefined();
    },
  );

  it.each(["foreign-turn", "malformed"] as const)(
    "reports an unsafe %s input request as a protocol failure",
    async (kind) => {
      const app = fixture();
      await vi.advanceTimersByTimeAsync(0);
      app.unsafeInputRequest(kind);
      app.terminal("interrupted");
      app.finishCleanup(true);

      await expect(app.run.result).resolves.toMatchObject({
        status: "failed", cleanupConfirmed: true,
        failure: { reason: "malformed-protocol" },
      });
    },
  );
});

// T3 b99333dc7: Codex wraps the Responses API's `invalid_encrypted_content` rejection in a generic turn error.
const REJECTED_HISTORY_MESSAGE = "Codex could not verify this session's encrypted conversation history. Send another message to continue in a fresh session with the visible conversation history.";
const REJECTED_HISTORY_RESPONSE = JSON.stringify({
  error: {
    type: "invalid_request_error",
    code: "invalid_encrypted_content",
    message: "Encrypted content could not be decrypted or parsed.",
  },
  headers: { "x-codex-turn-state": "dummy-sensitive" },
  status: 400,
});

describe("Codex rejecting the native thread's encrypted history", () => {
  function finalError(app: ReturnType<typeof fixture>, error: Record<string, unknown>, willRetry = false) {
    app.notification("error", { threadId: "thread-test", turnId: "turn-test", willRetry, error });
  }

  it.each([false, true])("classifies T3's fixture from the final error notification (through the harness: %s)", async (throughHarness) => {
    const app = fixture(throughHarness);
    await vi.advanceTimersByTimeAsync(0);
    finalError(app, { message: REJECTED_HISTORY_RESPONSE, codexErrorInfo: "other", additionalDetails: null });
    app.terminal("failed", { message: REJECTED_HISTORY_RESPONSE, codexErrorInfo: "other", additionalDetails: null });
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result).toMatchObject({ status: "failed", failure: { reason: "codex-error",
      code: "invalid_encrypted_content", message: REJECTED_HISTORY_MESSAGE } });
    if (throughHarness) expect("error" in result ? result.error : undefined).toBe(REJECTED_HISTORY_MESSAGE);
    // T3 stores only the code and its summary: none of the raw service response.
    expect(result.failure?.technicalDetail).toContain("Codex error: invalid_encrypted_content");
    expect(result.failure?.technicalDetail).not.toContain("Encrypted content could not be decrypted");
    expect(JSON.stringify(result)).not.toContain("dummy-sensitive");
    expect(JSON.stringify(result)).not.toContain("x-codex-turn-state");
    if (!throughHarness) expect(JSON.stringify(app.observed.onActivity.mock.calls)).not.toContain("dummy-sensitive");
  });

  it("keeps a failed turn's own classified error out of the technical detail", async () => {
    const app = fixture(true);
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("failed", { message: REJECTED_HISTORY_RESPONSE, codexErrorInfo: "other", additionalDetails: null });
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result.failure?.technicalDetail).toContain("Codex error: invalid_encrypted_content");
    expect(JSON.stringify(result)).not.toContain("dummy-sensitive");
    expect(JSON.stringify(result)).not.toContain("Encrypted content could not be decrypted");
  });

  it.each([false, true])("redacts the response headers of an unclassified Codex service error (retried first: %s)", async (retried) => {
    const response = JSON.stringify({
      error: { type: "server_error", code: "server_overloaded", message: "The server is overloaded." },
      headers: { "x-codex-turn-state": "dummy-sensitive", "x-request-id": "req-dummy-sensitive" },
      status: 503,
    });
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    if (retried) finalError(app, { message: response, codexErrorInfo: "other" }, true);
    finalError(app, { message: response, codexErrorInfo: "other", additionalDetails: null });
    app.terminal("failed", { message: response, codexErrorInfo: "other", additionalDetails: null });
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result.failure?.code).toBeUndefined();
    expect(result.failure?.technicalDetail).toContain("server_overloaded");
    expect(result.failure?.technicalDetail).toContain('"headers":"[redacted]"');
    expect(JSON.stringify(result)).not.toContain("dummy-sensitive");
    expect(JSON.stringify(app.observed.onActivity.mock.calls)).not.toContain("dummy-sensitive");
  });

  it.each([
    ["JSON", '{"error":{"code":"x"},"headers":{"a":"dummy-sensitive","b":"}{"},"status":400}', '{"error":{"code":"x"},"headers":"[redacted]","status":400}'],
    ["JSON inside a JSON string", '"{\\"headers\\":{\\"a\\":\\"dummy-sensitive\\"},\\"status\\":400}"',
      '"{\\"headers\\":\\"[redacted]\\",\\"status\\":400}"'],
    ["JSON inside a JSON string with braces and escaped quotes in values", '"{\\"headers\\":{\\"a\\":\\"}\\\\\\"{\\",\\"x-codex-turn-state\\":\\"dummy-sensitive\\"},\\"status\\":400}"',
      '"{\\"headers\\":\\"[redacted]\\",\\"status\\":400}"'],
    ["double-escaped JSON with braces and escaped quotes in values",
      JSON.stringify(JSON.stringify(JSON.stringify({ headers: { a: "}\\\"{", "x-codex-turn-state": "dummy-sensitive" }, status: 400 }))),
      JSON.stringify(JSON.stringify(JSON.stringify({ headers: "[redacted]", status: 400 })))],
    ["Rust debug text", 'status: 400, headers: {"a": "dummy-sensitive"}, body: x', 'status: 400, headers:[redacted], body: x'],
    ["Rust debug text inside a JSON string with a brace in a value",
      JSON.stringify('status: 400, headers: {"a": "}", "x-codex-turn-state": "dummy-sensitive"}, body: x'),
      JSON.stringify("status: 400, headers:[redacted], body: x")],
    ["a map cut off by a bound", '{"headers":{"a":"dummy-sensitive', '{"headers":"[redacted]"'],
    ["text without headers", "Codex could not continue.", "Codex could not continue."],
  ] as const)("redacts Codex header maps in %s", (_label, text, expected) => {
    expect(redactCodexErrorHeaders(text)).toBe(expected);
  });

  it.each([
    ["the additional details", { message: "Codex could not continue.", additionalDetails: REJECTED_HISTORY_RESPONSE }],
    ["the error's own code", { message: "Codex could not continue.", code: "invalid_encrypted_content" }],
    ["a bare code", { message: "invalid_encrypted_content" }],
    ["a service error without a wrapper", { message: JSON.stringify({ code: "invalid_encrypted_content" }) }],
  ] as const)("classifies %s of the final error notification", async (_label, error) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    finalError(app, error);
    app.terminal("failed", { message: "Codex could not continue." });
    app.finishCleanup(true);

    expect((await app.run.result).failure).toMatchObject({ code: "invalid_encrypted_content", message: REJECTED_HISTORY_MESSAGE });
  });

  it("classifies a failed turn's own error message without an error notification", async () => {
    const app = fixture(true);
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("failed", { message: REJECTED_HISTORY_RESPONSE, codexErrorInfo: "other", additionalDetails: null });
    app.finishCleanup(true);

    expect((await app.run.result).failure).toMatchObject({ code: "invalid_encrypted_content", message: REJECTED_HISTORY_MESSAGE });
  });

  it("names the rejection that the turn reports after an earlier unrelated final error", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    finalError(app, { message: "Codex could not continue." });
    app.terminal("failed", { message: REJECTED_HISTORY_RESPONSE });
    app.finishCleanup(true);

    expect((await app.run.result).failure).toMatchObject({ code: "invalid_encrypted_content", message: REJECTED_HISTORY_MESSAGE });
  });

  /** One run whose final error notification carries `error`; the turn then fails with a plain message. */
  async function notifiedOutcome(error: Record<string, unknown>, willRetry = false) {
    const app = fixture(true);
    await vi.advanceTimersByTimeAsync(0);
    finalError(app, error, willRetry);
    app.terminal("failed", { message: "Codex could not continue." });
    app.finishCleanup(true);
    return await app.run.result;
  }

  it.each([
    ["an unrelated service code", { message: JSON.stringify({ error: { code: "server_overloaded", message: "Overloaded" } }) }, false],
    ["plain provider text", { message: "Encrypted content could not be verified" }, false],
    ["a code nested below the service error", { message: JSON.stringify({ detail: { error: { code: "invalid_encrypted_content" } } }) }, false],
    ["a non-string code", { message: JSON.stringify({ error: { code: ["invalid_encrypted_content"] } }) }, false],
    ["truncated JSON", { message: REJECTED_HISTORY_RESPONSE.slice(0, 60) }, false],
    ["a non-string message", { message: { code: "invalid_encrypted_content" }, additionalDetails: 42 }, false],
    ["an oversized service response", { message: JSON.stringify({ error: { code: "invalid_encrypted_content" }, padding: "x".repeat(20_000) }) }, false],
    ["a rejection Codex retries", { message: REJECTED_HISTORY_RESPONSE }, true],
  ] as const)("leaves %s unclassified", async (_label, error, willRetry) => {
    // Control: the same run with T3's response is classified, so the negative below is not vacuous.
    expect((await notifiedOutcome({ message: REJECTED_HISTORY_RESPONSE })).failure?.code).toBe("invalid_encrypted_content");

    const result = await notifiedOutcome(error, willRetry);
    expect(result).toMatchObject({ status: "failed", failure: { reason: "codex-error" } });
    expect(result.failure?.code).toBeUndefined();
    expect(result.failure?.message).not.toBe(REJECTED_HISTORY_MESSAGE);
    expect(result.failure?.message.length).toBeLessThanOrEqual(4_000);
  });

  it("leaves an interrupted turn's error unclassified", async () => {
    const control = fixture();
    await vi.advanceTimersByTimeAsync(0);
    control.terminal("failed", { message: REJECTED_HISTORY_RESPONSE });
    control.finishCleanup(true);
    expect((await control.run.result).failure?.code).toBe("invalid_encrypted_content");

    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("interrupted", { message: REJECTED_HISTORY_RESPONSE, codexErrorInfo: null });
    app.finishCleanup(true);

    const result = await app.run.result;
    expect(result).toMatchObject({ status: "failed", failure: { reason: "codex-error" } });
    expect(result.failure?.code).toBeUndefined();
  });
});
