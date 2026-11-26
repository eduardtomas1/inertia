// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODEX_RETRY_BUDGET_EXCEEDED_MESSAGE,
  CODEX_RETRY_BUDGET_MS,
  projectCodexErrorNotification,
  resetCodexRetryBudget,
} from "../../src/server/codex/app-server-error-events";
import { CODEX_APP_SERVER_NOTIFICATION_DISPOSITIONS } from "../../src/server/codex/app-server-notifications";
import { openCodexTurn, startCodexAppServerRun } from "../../src/server/codex/app-server-run";
import { CodexErrorResponse } from "../../src/server/codex/app-server-request-errors";
import type { JsonObject } from "../../src/server/codex/protocol";
import { createCodexNativeConversationOperations } from "../../src/server/provider/codex-native-conversation";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

function customCodexServer(roots: string[], body: string) {
  const root = portableFixtureRoot("codex-hardening");
  roots.push(root);
  const command = portableNodeExecutable(root, "codex");
  writeNodeSubcommand(root, "app-server", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const turnShape = (id, status) => ({ id, items: [], itemsView: "notLoaded", status, error: null, startedAt: 1, completedAt: status === "inProgress" ? null : 1, durationMs: status === "inProgress" ? null : 0 });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "hardening-fixture" } });
  if (message.method === "initialized") return;
  ${body}
});
`);
  return { root, command };
}

describe("Codex App Server hardening & D.4", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it("catches exceptions thrown during handleServerRequest, onResponseFrame, and handleNotification without crashing", async () => {
    // 1. handleServerRequest throws via onApproval callback
    const reqFixture = customCodexServer(roots, `
      if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-1" }, model: "fake", serviceTier: null } });
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: turnShape("turn-1", "inProgress") } });
        send({ method: "turn/started", params: { threadId: "thread-1", turn: turnShape("turn-1", "inProgress") } });
        send({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", command: "echo hi", cwd: process.cwd(), availableDecisions: ["accept", "decline"] } });
      }
    `);
    const reqResult = await startCodexAppServerRun({
      executable: reqFixture.command,
      environment: process.env,
      cwd: reqFixture.root,
      prompt: "test",
      planMode: false,
      access: "supervised",
      onApproval: () => { throw new Error("boom in approval handler"); },
    }).result;
    expect(reqResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { reason: "malformed-protocol" },
    });

    // 2. onResponseFrame throws via onNativeBoundary callback
    const frameFixture = customCodexServer(roots, `
      if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-1" }, model: "fake", serviceTier: null } });
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: turnShape("turn-1", "inProgress") } });
      }
    `);
    const frameResult = await startCodexAppServerRun({
      executable: frameFixture.command,
      environment: process.env,
      cwd: frameFixture.root,
      prompt: "test",
      planMode: false,
      access: "supervised",
      onNativeBoundary: () => { throw new Error("boom in response frame"); },
    }).result;
    expect(frameResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { reason: "malformed-protocol" },
    });

    // 3. handleNotification throws via onText callback
    const notifFixture = customCodexServer(roots, `
      if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-1" }, model: "fake", serviceTier: null } });
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: turnShape("turn-1", "inProgress") } });
        send({ method: "turn/started", params: { threadId: "thread-1", turn: turnShape("turn-1", "inProgress") } });
        send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "m-1", delta: "hi" } });
      }
    `);
    const notifResult = await startCodexAppServerRun({
      executable: notifFixture.command,
      environment: process.env,
      cwd: notifFixture.root,
      prompt: "test",
      planMode: false,
      access: "supervised",
      onText: () => { throw new Error("boom in notification handler"); },
    }).result;
    expect(notifResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { reason: "malformed-protocol" },
    });
  });

  it("rejects an already-completed turn ID returned by turn/start before emitting boundaries or activating it (54d0a161bb)", async () => {
    const boundaries: Array<[string, string, string]> = [];
    const setActiveTurnId = vi.fn();
    let phase: "opening" | "starting-turn" | "running" | "settled" = "opening";

    await expect(openCodexTurn({
      options: {
        executable: process.execPath,
        environment: {},
        cwd: process.cwd(),
        prompt: "Hello",
        planMode: false,
        access: "supervised",
        onNativeBoundary: (t, turn, p) => boundaries.push([t, turn, p]),
      },
      modelProvider: undefined,
      request: async (method, _params, onResponseFrame) => {
        if (method === "initialize") return {};
        if (method === "thread/start") return { thread: { id: "thread-1" }, model: "fake", serviceTier: null };
        if (method === "turn/start") {
          const response = { turn: { id: "turn-already-completed", status: "inProgress" } };
          onResponseFrame?.(response);
          return response;
        }
        return {};
      },
      notify: vi.fn(),
      setProviderThreadId: vi.fn(),
      activeTurnId: () => undefined,
      setActiveTurnId,
      phase: () => phase,
      hasObservedTurn: (turnId) => turnId === "turn-already-completed",
      goalProjectionSequence: () => 0,
      beginGoalMutation: vi.fn(),
      endGoalMutation: vi.fn(),
      awaitInitialGoalTurn: vi.fn(),
      projectGoalResponse: () => null,
      setContinuationError: vi.fn(),
      setPhase: (next) => { phase = next as typeof phase; },
      isSettled: () => false,
      isCancelRequested: () => false,
      finish: vi.fn(),
    })).rejects.toThrow("already-completed turn identifier");

    expect(boundaries).toEqual([]);
    expect(setActiveTurnId).not.toHaveBeenCalled();

    // End-to-end wire fixture: turn/completed for stale-turn arrives during opening before turn/start echoes it.
    const wireFixture = customCodexServer(roots, `
      if (message.method === "thread/resume") {
        send({ id: message.id, result: { thread: { id: "thread-1" }, model: "fake", serviceTier: null } });
        send({ method: "turn/completed", params: { threadId: "thread-1", turn: turnShape("stale-turn", "completed") } });
        return;
      }
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: turnShape("stale-turn", "inProgress") } });
      }
    `);
    const wireBoundaries: unknown[] = [];
    const wireResult = await startCodexAppServerRun({
      executable: wireFixture.command,
      environment: process.env,
      cwd: wireFixture.root,
      prompt: "Continue",
      sessionId: "thread-1",
      planMode: false,
      access: "supervised",
      onNativeBoundary: (...args) => wireBoundaries.push(args),
    }).result;
    expect(wireResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { reason: "malformed-protocol" },
    });
    expect(wireBoundaries).toEqual([]);
  });

  it("handles thread/unarchived cleanly and retries archived or closing threads once on resume (9c8942480, ba962f2d2)", async () => {
    expect(CODEX_APP_SERVER_NOTIFICATION_DISPOSITIONS["thread/unarchived"]).toBe("ignored");

    // 1. Archived thread: thread/resume fails -> thread/unarchive + thread/unarchived notification -> thread/resume succeeds.
    const archivedFixture = customCodexServer(roots, `
      let unarchived = false;
      if (message.method === "thread/resume") {
        if (!globalThis.__unarchived) {
          return send({ id: message.id, error: { code: -32600, message: "thread thread-arch is archived" } });
        }
        return send({ id: message.id, result: { thread: { id: "thread-arch" }, model: "fake", serviceTier: null } });
      }
      if (message.method === "thread/unarchive") {
        globalThis.__unarchived = true;
        send({ method: "thread/unarchived", params: { threadId: message.params.threadId } });
        return send({ id: message.id, result: {} });
      }
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: turnShape("turn-1", "inProgress") } });
        send({ method: "turn/started", params: { threadId: "thread-arch", turn: turnShape("turn-1", "inProgress") } });
        send({ method: "item/agentMessage/delta", params: { threadId: "thread-arch", turnId: "turn-1", itemId: "m-1", delta: "Unarchived OK" } });
        send({ method: "turn/completed", params: { threadId: "thread-arch", turn: turnShape("turn-1", "completed") } });
      }
    `);
    const archivedResult = await startCodexAppServerRun({
      executable: archivedFixture.command,
      environment: process.env,
      cwd: archivedFixture.root,
      prompt: "Resume me",
      sessionId: "thread-arch",
      planMode: false,
      access: "supervised",
    }).result;
    expect(archivedResult).toMatchObject({
      status: "completed",
      sessionId: "thread-arch",
      text: "Unarchived OK",
      cleanupConfirmed: true,
    });
    expect(archivedResult.failure).toBeUndefined();

    // 2. Closing thread: first thread/resume fails with closing -> bounded wait -> second thread/resume succeeds.
    const calls: string[] = [];
    let resumeAttempts = 0;
    await openCodexTurn({
      options: {
        executable: process.execPath,
        environment: {},
        cwd: process.cwd(),
        prompt: "Resume closing",
        sessionId: "thread-closing",
        planMode: false,
        access: "supervised",
      },
      modelProvider: undefined,
      request: async (method) => {
        calls.push(method);
        if (method === "thread/resume") {
          resumeAttempts += 1;
          if (resumeAttempts === 1) throw new CodexErrorResponse("thread thread-closing is closing", -32600);
          return { thread: { id: "thread-closing" }, model: "fake", serviceTier: null };
        }
        if (method === "turn/start") return { turn: { id: "turn-2", status: "inProgress" } };
        return {};
      },
      notify: vi.fn(),
      setProviderThreadId: vi.fn(),
      activeTurnId: () => undefined,
      setActiveTurnId: vi.fn(),
      phase: () => "starting-turn",
      hasObservedTurn: () => false,
      goalProjectionSequence: () => 0,
      beginGoalMutation: vi.fn(),
      endGoalMutation: vi.fn(),
      awaitInitialGoalTurn: vi.fn(),
      projectGoalResponse: () => null,
      setContinuationError: vi.fn(),
      setPhase: vi.fn(),
      isSettled: () => false,
      isCancelRequested: () => false,
      finish: vi.fn(),
    });
    expect(calls).toEqual(["initialize", "thread/resume", "thread/resume", "turn/start"]);
  });

  it("retries Codex native conversation operations via thread/unarchive when the thread is archived", async () => {
    const methods: string[] = [];
    let unarchived = false;
    const ops = createCodexNativeConversationOperations(new Set(), async (_opts, run) => await run({
      request: async (method: string, params: JsonObject = {}) => {
        methods.push(method);
        if (method === "thread/unarchive") {
          unarchived = true;
          return {};
        }
        if (method === "thread/read") {
          if (params.threadId === "thread-src" && !unarchived) {
            throw new Error("thread thread-src is archived");
          }
          return {
            thread: {
              id: params.threadId,
              sessionId: "sess-1",
              historyMode: "paginated",
              status: { type: "idle" },
            },
          };
        }
        if (method === "thread/turns/list") {
          return {
            data: [
              { id: "turn-2", status: "completed" },
              { id: "turn-1", status: "completed" },
            ],
            nextCursor: null,
          };
        }
        if (method === "thread/fork") {
          return {
            thread: {
              id: "thread-fork",
              forkedFromId: "thread-src",
              sessionId: "sess-1",
              historyMode: "paginated",
              status: { type: "idle" },
            },
          };
        }
        return {};
      },
    }));

    const result = await ops.execute({
      kind: "fork",
      operationId: "op-unarchive-1",
      targetConversationId: "conv-fork-1",
      source: {
        identity: {
          projectId: "proj-1",
          conversationId: "conv-1",
          workspaceId: process.cwd(),
          repositoryId: null,
          providerInstanceId: "codex:default",
        },
        nativeConversationId: "thread-src",
        nativeSessionId: "sess-1",
        expectedHeadId: "turn-2",
      },
      boundary: { kind: "turn", nativeTurnId: "turn-2" },
    }, {
      executable: process.execPath,
      environment: {},
      cwd: process.cwd(),
    });

    expect(result).toMatchObject({
      status: "completed",
      effect: "native-fork",
      backing: { nativeConversationId: "thread-fork", headId: "turn-2" },
    });
    expect(methods.slice(0, 3)).toEqual(["thread/read", "thread/unarchive", "thread/read"]);
  });

  it("respects configured model_reasoning_summary and falls back to auto when unconfigured (12b29eb71)", async () => {
    const captureSummary = async (configResponse: JsonObject | null): Promise<unknown> => {
      let sentSummary: unknown;
      await openCodexTurn({
        options: {
          executable: process.execPath,
          environment: {},
          cwd: process.cwd(),
          prompt: "Explain",
          planMode: false,
          access: "supervised",
          sessionDeveloperInstructions: "session note",
        },
        modelProvider: undefined,
        request: async (method, params) => {
          if (method === "config/read") return configResponse ?? {};
          if (method === "thread/start") return { thread: { id: "thread-1" }, model: "fake", serviceTier: null };
          if (method === "turn/start") {
            sentSummary = params.summary;
            return { turn: { id: "turn-1", status: "inProgress" } };
          }
          return {};
        },
        notify: vi.fn(),
        setProviderThreadId: vi.fn(),
        activeTurnId: () => undefined,
        setActiveTurnId: vi.fn(),
        phase: () => "starting-turn",
        hasObservedTurn: () => false,
        goalProjectionSequence: () => 0,
        beginGoalMutation: vi.fn(),
        endGoalMutation: vi.fn(),
        awaitInitialGoalTurn: vi.fn(),
        projectGoalResponse: () => null,
        setContinuationError: vi.fn(),
        setPhase: vi.fn(),
        isSettled: () => false,
        isCancelRequested: () => false,
        finish: vi.fn(),
      });
      return sentSummary;
    };

    expect(await captureSummary({ config: { model_reasoning_summary: "detailed" } })).toBe("detailed");
    expect(await captureSummary({ config: { model_reasoning_summary: "none" } })).toBe("none");
    expect(await captureSummary({ config: {} })).toBe("auto");
  });

  it("enforces the 10-minute retry budget on consecutive willRetry errors and resets on progress", () => {
    expect(CODEX_RETRY_BUDGET_MS).toBe(10 * 60 * 1_000);
    let now = 1_000;
    const statuses: string[] = [];
    const rememberFailure = vi.fn();
    const finish = vi.fn();
    const setLastError = vi.fn();
    const host = {
      options: {
        executable: process.execPath,
        environment: {},
        cwd: process.cwd(),
        prompt: "hi",
        planMode: false,
        access: "supervised" as const,
        onStatus: (status: string) => statuses.push(status),
      },
      setLastError,
      rememberFailure,
      finish,
    };

    const retryParams = { error: { message: "transient 503" }, willRetry: true };
    projectCodexErrorNotification(host, retryParams, { now: () => now, maxRetryDurationMs: 5_000 });
    now += 4_000;
    projectCodexErrorNotification(host, retryParams, { now: () => now, maxRetryDurationMs: 5_000 });
    expect(statuses).toEqual(["retrying", "retrying"]);
    expect(rememberFailure).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();

    // Progress resets the retry window.
    resetCodexRetryBudget(host);
    now += 4_000;
    projectCodexErrorNotification(host, retryParams, { now: () => now, maxRetryDurationMs: 5_000 });
    expect(rememberFailure).not.toHaveBeenCalled();

    // Exceeding the budget fails cleanly.
    now += 5_000;
    projectCodexErrorNotification(host, retryParams, { now: () => now, maxRetryDurationMs: 5_000 });
    expect(rememberFailure).toHaveBeenCalledWith(
      "codex-error",
      CODEX_RETRY_BUDGET_EXCEEDED_MESSAGE,
      "transient 503",
      false,
      undefined,
      undefined,
    );
    expect(finish).toHaveBeenCalledWith("failed", 1, null);
  });
});
