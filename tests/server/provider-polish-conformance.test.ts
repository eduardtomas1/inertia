// @inertia-test-suite portable
import type { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Options as ClaudeOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk/unstable";

import {
  CLAUDE_STARTUP_INIT_TIMEOUT_MESSAGE,
  CLAUDE_STARTUP_INIT_TIMEOUT_MS,
  createClaudeAgentSdkHarness,
} from "../../src/server/provider/claude-agent-sdk-harness";
import { startHarnessWithFreshSessionFallback } from "../../src/server/provider/fresh-session-fallback";
import {
  CODEX_REASONING_SUMMARIES,
  startCodexAppServerRun,
  validatedCodexReasoningSummary,
} from "../../src/server/codex/app-server-run";
import { acpStopReasonMessage } from "../../src/server/provider/acp-stop-reasons";
import { isInertiaHostMcpPermissionRequest } from "../../src/server/provider/acp-host-tool-permission";
import { INERTIA_HOST_MCP_NAME } from "../../src/server/provider/host-tool-mcp-config";
import { BoundedJsonLineTransform } from "../../src/server/provider/cursor-acp-framing";
import {
  askCursorPermission,
  cursorOneShotPermissionOption,
  cursorPermission,
  MAX_PENDING_CURSOR_INTERACTIONS,
  type PendingCursorApproval,
} from "../../src/server/provider/cursor-acp-permissions";
import { createAgentHarnessEmitter, type AgentHarnessStartOptions } from "../../src/server/provider/agent-harness";
import { CappedProviderBuffer, ProviderRunEventBudget } from "../../src/server/provider/io";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { fakeClaudeChild } from "../helpers/claude-harness-fixture";
import { captured, fakeAppServer as createFakeAppServer } from "../helpers/codex-app-server-fixture";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const SAVED_SESSION_ID = "5e9c1b20-1111-4222-8333-444455556666";

function hangingClaudeStream(): AsyncGenerator<SDKMessage> {
  const iterator: AsyncIterator<SDKMessage> & AsyncIterable<SDKMessage> = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise<IteratorResult<SDKMessage>>(() => undefined),
    return: async () => ({ done: true, value: undefined }),
    throw: async (error: unknown) => { throw error; },
  };
  return iterator as unknown as AsyncGenerator<SDKMessage>;
}

function throwingClaudeStream(createError: () => Promise<Error>): AsyncGenerator<SDKMessage> {
  const iterator: AsyncIterator<SDKMessage> & AsyncIterable<SDKMessage> = {
    [Symbol.asyncIterator]() { return this; },
    next: async () => { throw await createError(); },
    return: async () => ({ done: true, value: undefined }),
    throw: async (error: unknown) => { throw error; },
  };
  return iterator as unknown as AsyncGenerator<SDKMessage>;
}

function claudeFailedResult(fields: Record<string, unknown>): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    uuid: "refusal-result",
    session_id: SAVED_SESSION_ID,
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: [],
    ...fields,
  } as unknown as SDKMessage;
}

describe("Provider polish conformance fixtures (C4, 0072f66ec, 12b29eb71, ddc4f5760, 629d5083b)", () => {
  const roots: string[] = [];
  const originalCapturePath = process.env.INERTIA_APP_SERVER_CAPTURE;
  const originalScenario = process.env.INERTIA_APP_SERVER_SCENARIO;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalCapturePath === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
    else process.env.INERTIA_APP_SERVER_CAPTURE = originalCapturePath;
    if (originalScenario === undefined) delete process.env.INERTIA_APP_SERVER_SCENARIO;
    else process.env.INERTIA_APP_SERVER_SCENARIO = originalScenario;
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  describe("Claude startup/MCP initialization deadline (0072f66ec)", () => {
    it("defaults the startup initialization deadline to 90 seconds", () => {
      expect(CLAUDE_STARTUP_INIT_TIMEOUT_MS).toBe(90_000);
    });

    it("aborts cleanly, terminates the process tree, and retries once on a fresh session start", async () => {
      const root = portableFixtureRoot("Claude startup init retry success");
      roots.push(root);
      const aborted: boolean[] = [];
      const closed: number[] = [];
      const terminatedPids: number[] = [];
      let attempts = 0;

      const harness = createClaudeAgentSdkHarness({
        startupInitTimeoutMs: 50,
        spawnProcess: (() => fakeClaudeChild(5_100 + attempts)) as never,
        terminateProcessTree: async (child) => {
          terminatedPids.push(child.pid ?? -1);
          return true;
        },
        createQuery: ({ options }) => {
          attempts += 1;
          const attempt = attempts;
          options?.spawnClaudeCodeProcess?.({
            command: process.execPath,
            args: [],
            cwd: root,
            env: {},
            signal: options.abortController!.signal,
          });
          options?.abortController?.signal.addEventListener("abort", () => {
            aborted.push(true);
          });
          if (attempt === 1) {
            return fixtureClaudeQuery(hangingClaudeStream(), {
              close: () => {
                closed.push(attempt);
              },
            });
          }
          return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("init");
            yield claudeSuccessResult("Recovered on retry");
          })(), {
            close: () => {
              closed.push(attempt);
            },
          });
        },
      });

      const result = await harness.start({
        input: nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-startup-init-retry-ok",
          cwd: root,
          prompt: "Start fresh",
          interactionMode: "build",
          access: "supervised",
        }),
        executable: process.execPath,
        environment: {},
        providerNativeToolsAvailable: true,
      }).result;

      expect(result).toMatchObject({
        status: "completed",
        text: "Recovered on retry",
        sessionId: CLAUDE_PROTOCOL_SESSION_ID,
        cleanupConfirmed: true,
      });
      expect(attempts).toBe(2);
      expect(aborted).toEqual([true]);
      expect(closed).toContain(1);
      expect(terminatedPids).toEqual([5_101, 5_102]);
    });

    it("fails cleanly with notDelivered when both fresh startup attempts time out and reflects teardown status", async () => {
      const root = portableFixtureRoot("Claude startup init retry exhausted");
      roots.push(root);
      let attempts = 0;
      const terminatedPids: number[] = [];

      const harness = createClaudeAgentSdkHarness({
        startupInitTimeoutMs: 50,
        spawnProcess: (() => fakeClaudeChild(5_200 + attempts)) as never,
        terminateProcessTree: async (child) => {
          terminatedPids.push(child.pid ?? -1);
          return true;
        },
        createQuery: ({ options }) => {
          attempts += 1;
          options?.spawnClaudeCodeProcess?.({
            command: process.execPath,
            args: [],
            cwd: root,
            env: {},
            signal: options.abortController!.signal,
          });
          return fixtureClaudeQuery(hangingClaudeStream());
        },
      });

      const result = await harness.start({
        input: nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-startup-init-retry-fail",
          cwd: root,
          prompt: "Start fresh and hang",
          interactionMode: "build",
          access: "supervised",
        }),
        executable: process.execPath,
        environment: {},
        providerNativeToolsAvailable: true,
      }).result;

      expect(attempts).toBe(2);
      expect(terminatedPids).toEqual([5_201, 5_202]);
      expect(result).toMatchObject({
        status: "failed",
        error: CLAUDE_STARTUP_INIT_TIMEOUT_MESSAGE,
        cleanupConfirmed: true,
        failure: {
          message: CLAUDE_STARTUP_INIT_TIMEOUT_MESSAGE,
          terminalEvent: "startup/init-timeout",
          notDelivered: true,
        },
      });
      expect(result.failure?.sessionUnavailable).toBeUndefined();

      let unconfirmedAttempts = 0;
      const unconfirmedHarness = createClaudeAgentSdkHarness({
        startupInitTimeoutMs: 50,
        spawnProcess: (() => fakeClaudeChild(5_250 + unconfirmedAttempts)) as never,
        terminateProcessTree: async () => false,
        createQuery: ({ options }) => {
          unconfirmedAttempts += 1;
          options?.spawnClaudeCodeProcess?.({
            command: process.execPath,
            args: [],
            cwd: root,
            env: {},
            signal: options.abortController!.signal,
          });
          return fixtureClaudeQuery(hangingClaudeStream());
        },
      });

      const unconfirmed = await unconfirmedHarness.start({
        input: nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-startup-init-unconfirmed",
          cwd: root,
          prompt: "Hang with unconfirmed cleanup",
          interactionMode: "build",
          access: "supervised",
        }),
        executable: process.execPath,
        environment: {},
        providerNativeToolsAvailable: true,
      }).result;

      expect(unconfirmedAttempts).toBe(1);
      expect(unconfirmed).toMatchObject({
        status: "failed",
        error: CLAUDE_STARTUP_INIT_TIMEOUT_MESSAGE,
        cleanupConfirmed: false,
        failure: {
          terminalEvent: "startup/init-timeout",
          notDelivered: true,
        },
      });
    });

    it("fails immediately without retrying on a resumed session startup timeout and preserves the session", async () => {
      const root = portableFixtureRoot("Claude resume startup init timeout");
      roots.push(root);
      let attempts = 0;
      const terminatedPids: number[] = [];

      const harness = createClaudeAgentSdkHarness({
        startupInitTimeoutMs: 50,
        spawnProcess: (() => fakeClaudeChild(5_300 + attempts)) as never,
        terminateProcessTree: async (child) => {
          terminatedPids.push(child.pid ?? -1);
          return true;
        },
        createQuery: ({ options }) => {
          attempts += 1;
          options?.spawnClaudeCodeProcess?.({
            command: process.execPath,
            args: [],
            cwd: root,
            env: {},
            signal: options.abortController!.signal,
          });
          return fixtureClaudeQuery(hangingClaudeStream());
        },
      });

      const result = await harness.start({
        input: nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-resume-startup-timeout",
          cwd: root,
          prompt: "Resume and hang",
          interactionMode: "build",
          access: "supervised",
          sessionId: SAVED_SESSION_ID,
        }),
        executable: process.execPath,
        environment: {},
        providerNativeToolsAvailable: true,
      }).result;

      expect(attempts).toBe(1);
      expect(terminatedPids).toEqual([5_301]);
      expect(result).toMatchObject({
        status: "failed",
        sessionId: SAVED_SESSION_ID,
        error: CLAUDE_STARTUP_INIT_TIMEOUT_MESSAGE,
        cleanupConfirmed: true,
        failure: {
          terminalEvent: "startup/init-timeout",
          notDelivered: true,
        },
      });
      expect(result.failure?.sessionUnavailable).toBeUndefined();
    });

    it("clears the startup deadline on the first SDK event so long healthy turns complete normally", async () => {
      const root = portableFixtureRoot("Claude startup init cleared on first event");
      roots.push(root);
      const harness = createClaudeAgentSdkHarness({
        startupInitTimeoutMs: 50,
        createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSystem("init");
          await new Promise<void>((resolve) => setTimeout(resolve, 90));
          yield claudeSuccessResult("Healthy long turn");
        })()),
      });

      const result = await harness.start({
        input: nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-healthy-after-init",
          cwd: root,
          prompt: "Take longer than startup timeout after init",
          interactionMode: "build",
          access: "supervised",
        }),
        executable: process.execPath,
        environment: {},
        providerNativeToolsAvailable: true,
      }).result;

      expect(result).toMatchObject({
        status: "completed",
        text: "Healthy long turn",
        cleanupConfirmed: true,
      });
    });
  });

  describe("Claude stderr-only missing session (629d5083b) and pre-attachment refusal (ddc4f5760)", () => {
    it("marks stderr-only 'No conversation found with session ID' as sessionUnavailable on resume only (629d5083b)", async () => {
      const root = portableFixtureRoot("Claude stderr-only missing session");
      roots.push(root);

      const makeHarness = () => createClaudeAgentSdkHarness({
        spawnProcess: (() => {
          const child = fakeClaudeChild(5_401);
          queueMicrotask(() => {
            (child.stderr as PassThrough).write(`Error: No conversation found with session ID: ${SAVED_SESSION_ID}\n`);
            Object.assign(child, { exitCode: 1 });
          });
          return child;
        }) as never,
        terminateProcessTree: async () => true,
        createQuery: ({ options }) => {
          options?.spawnClaudeCodeProcess?.({
            command: process.execPath,
            args: [],
            cwd: root,
            env: {},
            signal: options.abortController!.signal,
          });
          return fixtureClaudeQuery(throwingClaudeStream(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            return Object.assign(new Error("Claude Code process exited with code 1"), {
              errorClass: "process_exited_nonzero",
              telemetryMessage: "Claude Code process exited with code 1",
            });
          }));
        },
      });

      const resumedResult = await makeHarness().start({
        input: nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-stderr-missing-resume",
          cwd: root,
          prompt: "Continue",
          interactionMode: "build",
          access: "supervised",
          sessionId: SAVED_SESSION_ID,
        }),
        executable: process.execPath,
        environment: {},
        providerNativeToolsAvailable: true,
      }).result;

      expect(resumedResult).toMatchObject({
        status: "failed",
        cleanupConfirmed: true,
        failure: {
          sessionUnavailable: true,
        },
      });

      const freshResult = await makeHarness().start({
        input: nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-stderr-missing-fresh",
          cwd: root,
          prompt: "Fresh",
          interactionMode: "build",
          access: "supervised",
        }),
        executable: process.execPath,
        environment: {},
        providerNativeToolsAvailable: true,
      }).result;

      expect(freshResult.status).toBe("failed");
      expect(freshResult.failure?.sessionUnavailable).toBeUndefined();
    });

    it("preserves the saved session with notDelivered on pre-attachment refusal without triggering fresh fallback (ddc4f5760)", async () => {
      const root = portableFixtureRoot("Claude pre-attachment refusal");
      roots.push(root);
      const launches: Array<ClaudeOptions | undefined> = [];
      const fallback = vi.fn(() => ({ prompt: "Should not run fresh fallback" }));

      const harness = createClaudeAgentSdkHarness({
        createQuery: ({ options }) => {
          launches.push(options);
          return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
            yield claudeFailedResult({
              startup_failure_reason: "session_held_by_background",
              errors: ["Session is currently held by background task."],
            });
          })());
        },
      });

      const result = await startHarnessWithFreshSessionFallback(harness, {
        input: nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-pre-attach-refusal",
          cwd: root,
          prompt: "Continue while busy",
          interactionMode: "build",
          access: "supervised",
          sessionId: SAVED_SESSION_ID,
        }),
        executable: process.execPath,
        environment: {},
        providerNativeToolsAvailable: true,
      }, fallback).result;

      expect(launches).toHaveLength(1);
      expect(fallback).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: "failed",
        sessionId: SAVED_SESSION_ID,
        cleanupConfirmed: true,
        failure: {
          terminalEvent: "result/session_held_by_background",
          notDelivered: true,
        },
      });
      expect(result.failure?.sessionUnavailable).toBeUndefined();
    });
  });

  describe("Codex reasoningSummary config propagation (12b29eb71)", () => {
    it("validates allowed reasoningSummary values and rejects invalid ones", () => {
      expect(CODEX_REASONING_SUMMARIES).toEqual(["auto", "concise", "detailed", "none"]);
      expect(validatedCodexReasoningSummary("concise")).toBe("concise");
      expect(validatedCodexReasoningSummary(" DETAILED ")).toBe("detailed");
      expect(validatedCodexReasoningSummary("none")).toBe("none");
      expect(validatedCodexReasoningSummary("auto")).toBe("auto");
      expect(validatedCodexReasoningSummary("verbose")).toBeUndefined();
      expect(validatedCodexReasoningSummary("")).toBeUndefined();
      expect(validatedCodexReasoningSummary(123)).toBeUndefined();
      expect(validatedCodexReasoningSummary(null)).toBeUndefined();
    });

    it.each([
      ["concise", "concise"],
      ["detailed", "detailed"],
      ["none", "none"],
      ["invalid-mode", "auto"],
      [42, "auto"],
      [undefined, "auto"],
    ] as const)(
      "propagates modelSelection.providerOptions.reasoningSummary (%s -> %s) through the fake Codex App Server",
      async (configuredSummary, expectedSummary) => {
        const fake = createFakeAppServer(roots);
        process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;

        const run = startCodexAppServerRun({
          executable: fake.command,
          environment: { ...process.env, INERTIA_APP_SERVER_CAPTURE: fake.capturePath },
          cwd: fake.root,
          prompt: "Check reasoning summary",
          planMode: false,
          access: "supervised",
          modelSelection: {
            providerOptions: configuredSummary === undefined
              ? {}
              : { reasoningSummary: configuredSummary },
          },
          onApproval: (request) => {
            run.respondToApproval(request.requestId, "approve");
          },
          onInputRequest: (request) => {
            run.respondToInput(request.requestId, { choice: ["Safe"] });
          },
        });

        const result = await run.result;
        expect(result).toMatchObject({ status: "completed", cleanupConfirmed: true });

        const messages = captured(fake.capturePath);
        const turnStart = messages.find(({ method }) => method === "turn/start") as { params: Record<string, unknown> } | undefined;
        expect(turnStart?.params.summary).toBe(expectedSummary);
      },
    );
  });

  describe("ACP conformance fixtures (C4)", () => {
    it("tolerates blank lines in ACP JSON-RPC framing while rejecting malformed non-blank frames", async () => {
      const budget = new ProviderRunEventBudget("ACP", 16 * 1024, 64, 64 * 1024);
      const transform = new BoundedJsonLineTransform(16 * 1024, budget);
      const output: string[] = [];
      transform.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));

      const validUpdate = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello ACP" },
          },
        },
      });
      const validResponse = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { stopReason: "end_turn" },
      });

      const finished = new Promise<void>((resolve, reject) => {
        transform.once("end", resolve);
        transform.once("error", reject);
      });
      transform.write("\n   \r\n");
      transform.write(`${validUpdate}\n`);
      transform.write("\t\n\n");
      transform.write(`${validResponse}\n   \n`);
      transform.end();
      await finished;

      expect(output.join("")).toBe(`${validUpdate}\n${validResponse}\n`);

      const malformedBudget = new ProviderRunEventBudget("ACP", 16 * 1024, 64, 64 * 1024);
      const malformedTransform = new BoundedJsonLineTransform(16 * 1024, malformedBudget);
      const malformedError = new Promise<Error>((resolve) => {
        malformedTransform.once("error", resolve);
      });
      malformedTransform.write('{"jsonrpc":"1.0","id":1,"result":{}}\n');
      expect((await malformedError).message).toContain("malformed JSON-RPC frame");
    });

    it("maps ACP stop reasons accurately and clips unknown stop reasons", () => {
      expect(acpStopReasonMessage("Cursor", "refusal")).toBe("Cursor declined this request.");
      expect(acpStopReasonMessage("Kimi", "max_tokens")).toBe(
        "Kimi hit its output token limit. Ask it to continue.",
      );
      expect(acpStopReasonMessage("Grok", "max_turn_requests")).toBe(
        "Grok hit its request limit for this turn. Ask it to continue.",
      );
      expect(acpStopReasonMessage("Antigravity", "custom_limit")).toBe(
        "Antigravity stopped with reason: custom_limit.",
      );
      const overlongReason = "x".repeat(120);
      expect(acpStopReasonMessage("Cursor", overlongReason)).toBe(
        `Cursor stopped with reason: ${"x".repeat(64)}.`,
      );
    });

    it("enforces bounded notification frame limits and capped buffer retention", async () => {
      const tinyBudget = new ProviderRunEventBudget("ACP", 256, 2, 512, { maxRunEvents: 2, maxRunBytes: 512 });
      const lineTransform = new BoundedJsonLineTransform(128, tinyBudget);
      const overflowError = new Promise<Error>((resolve) => {
        lineTransform.once("error", resolve);
      });
      lineTransform.write(`${"a".repeat(129)}\n`);
      expect((await overflowError).message).toContain("oversized JSON-RPC frame");

      const rateBudget = new ProviderRunEventBudget("ACP", 1024, 2, 4096, { maxRunEvents: 2, maxRunBytes: 4096 });
      const rateTransform = new BoundedJsonLineTransform(1024, rateBudget);
      const rateError = new Promise<Error>((resolve) => {
        rateTransform.once("error", resolve);
      });
      const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`;
      rateTransform.write(frame);
      rateTransform.write(frame);
      rateTransform.write(frame);
      expect((await rateError).message).toContain("bounded event budget");

      const buffer = new CappedProviderBuffer(16);
      buffer.append("0123456789");
      buffer.append("abcdef");
      expect(buffer.truncated).toBe(false);
      buffer.append("EXTRA");
      expect(buffer.truncated).toBe(true);
      expect(buffer.toString()).toBe("0123456789abcdef");
    });

    it("enforces ACP approval queue bounds, one-shot permission discipline, and host MCP spoofing guards", async () => {
      const options: PermissionOption[] = [
        { optionId: "always-allow", name: "Always allow", kind: "allow_always" },
        { optionId: "always-deny", name: "Always deny", kind: "reject_always" },
      ];
      expect(cursorOneShotPermissionOption(options, true)).toBeUndefined();
      expect(cursorOneShotPermissionOption(options, false)).toBeUndefined();

      const oneShotOptions: PermissionOption[] = [
        ...options,
        { optionId: "once-allow", name: "Allow once", kind: "allow_once" },
        { optionId: "once-deny", name: "Deny once", kind: "reject_once" },
      ];
      expect(cursorOneShotPermissionOption(oneShotOptions, true)?.optionId).toBe("once-allow");
      expect(cursorOneShotPermissionOption(oneShotOptions, false)?.optionId).toBe("once-deny");

      const registered = new Set(["read_workspace_file"]);
      expect(isInertiaHostMcpPermissionRequest({
        toolCall: {
          toolCallId: "tc-1",
          kind: "read",
          name: `mcp__${INERTIA_HOST_MCP_NAME}__read_workspace_file`,
          title: "Read file",
        },
      }, registered)).toBe(true);
      expect(isInertiaHostMcpPermissionRequest({
        toolCall: {
          toolCallId: "tc-2",
          kind: "execute",
          name: `mcp__${INERTIA_HOST_MCP_NAME}__read_workspace_file`,
          title: "Spoofed execute",
        },
      }, registered)).toBe(false);
      expect(isInertiaHostMcpPermissionRequest({
        toolCall: {
          toolCallId: "tc-3",
          kind: "read",
          name: "mcp__foreign-server__read_workspace_file",
          title: `mcp__${INERTIA_HOST_MCP_NAME}__read_workspace_file`,
        },
      }, registered)).toBe(false);

      const root = portableFixtureRoot("ACP approval bounds");
      roots.push(root);
      const startOptions: AgentHarnessStartOptions = {
        input: nativeProviderRunInput({
          providerId: "cursor",
          conversationId: "acp-approval-bounds",
          cwd: root,
          prompt: "Check approval bounds",
          interactionMode: "build",
          access: "supervised",
        }),
        executable: process.execPath,
        environment: {},
        providerNativeToolsAvailable: true,
      };
      const emitter = createAgentHarnessEmitter(
        "cursor",
        startOptions.input.conversationId,
        undefined,
        startOptions.input.runId,
        startOptions.input.turnId,
        root,
      );
      const controller = new AbortController();
      const unsafeRequest: RequestPermissionRequest = {
        sessionId: "acp-session-1",
        toolCall: {
          toolCallId: "tc-unsafe",
          kind: "execute",
          title: "Run\u202Etxt.exe",
        },
        options: oneShotOptions,
      };
      const unsafeOutcome = await cursorPermission(
        unsafeRequest,
        unsafeRequest,
        controller.signal,
        startOptions,
        emitter.rich,
        new Map(),
      );
      expect(unsafeOutcome).toEqual({ outcome: { outcome: "cancelled" } });

      const saturated = new Map<string, PendingCursorApproval>();
      for (let index = 0; index < MAX_PENDING_CURSOR_INTERACTIONS; index += 1) {
        saturated.set(`pending-${index}`, { resolve: () => undefined, settled: false });
      }
      const safeRequest: RequestPermissionRequest = {
        sessionId: "acp-session-1",
        toolCall: {
          toolCallId: "tc-overflow",
          kind: "execute",
          title: "Run npm test",
        },
        options: oneShotOptions,
      };
      await expect(askCursorPermission(
        safeRequest,
        safeRequest,
        controller.signal,
        startOptions,
        emitter.rich,
        saturated,
      )).rejects.toThrow("Cursor exceeded the bounded approval budget.");
    });
  });
});
