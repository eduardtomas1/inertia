// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { claudeSessionUnavailable, claudeStartupFailure } from "../../src/server/provider/claude-startup-failure";
import { startHarnessWithFreshSessionFallback } from "../../src/server/provider/fresh-session-fallback";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude startup failures", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removePortableFixture(root)));
  });

  it("asks Claude Code for structured startup failures and explains them", async () => {
    const root = portableFixtureRoot("Claude startup failure");
    roots.push(root);
    let capturedOptions: Options | undefined;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        capturedOptions = options;
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield {
            type: "result",
            subtype: "error_during_execution",
            uuid: "startup-failure",
            session_id: CLAUDE_PROTOCOL_SESSION_ID,
            duration_ms: 0,
            duration_api_ms: 0,
            is_error: true,
            num_turns: 0,
            stop_reason: null,
            total_cost_usd: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
            modelUsage: {},
            permission_denials: [],
            errors: [`Invalid proxy URL in HTTPS_PROXY read from ${root}/proxy.env with credential opaque-proxy-credential-99. Fix or unset HTTPS_PROXY.`],
            startup_failure_reason: "proxy_invalid",
          } as unknown as SDKMessage;
        })());
      },
    });
    const run = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-startup-failure",
        cwd: root,
        prompt: "Start",
        interactionMode: "build",
        access: "supervised",
      }),
      executable: process.execPath,
      environment: { HTTPS_PROXY: "invalid", ANTHROPIC_AUTH_TOKEN: "opaque-proxy-credential-99" },
      providerNativeToolsAvailable: true,
    });

    await expect(run.result).resolves.toMatchObject({
      status: "failed",
      error: "Claude Code's proxy setting isn't a valid URL. Fix it, then try again.",
      failure: {
        terminalEvent: "result/proxy_invalid",
        technicalDetail: "Invalid proxy URL in HTTPS_PROXY read from <workspace>/proxy.env with credential [redacted]. Fix or unset HTTPS_PROXY.",
      },
    });
    expect(capturedOptions?.env).toMatchObject({
      CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
      CLAUDE_CODE_EAGER_FLUSH: "1",
      HTTPS_PROXY: "invalid",
    });
  });

  const savedSessionId = "3f0c7d52-1111-4222-8333-444455556666";
  function failedResult(fields: Record<string, unknown>): SDKMessage {
    return {
      type: "result",
      subtype: "error_during_execution",
      uuid: "resume-failure",
      session_id: savedSessionId,
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
  const missingSession = failedResult({
    errors: [`No conversation found with session ID: ${savedSessionId}`],
  });

  it("recognises the results Claude Code returns when it cannot resume a session", () => {
    expect(claudeSessionUnavailable(missingSession)).toBe(true);
    expect(claudeSessionUnavailable(failedResult({ startup_failure_reason: "worktree_resume_refused" }))).toBe(true);
    expect(claudeSessionUnavailable(failedResult({ errors: ["Rate limit reached"] }))).toBe(false);
    expect(claudeSessionUnavailable(failedResult({
      num_turns: 3,
      errors: [`No conversation found with session ID: ${savedSessionId}`],
    }))).toBe(false);
    expect(claudeSessionUnavailable(failedResult({ startup_failure_reason: "proxy_invalid" }))).toBe(false);
    expect(claudeSessionUnavailable(claudeSuccessResult("Done"))).toBe(false);
    expect(claudeSessionUnavailable(claudeSystem("init"))).toBe(false);
  });

  it("explains a session on an API provider that managed settings do not allow", () => {
    const result = failedResult({
      startup_failure_reason: "provider_not_allowed",
      errors: ["This machine's managed settings do not allow the customEndpoint API provider."],
    }) as Extract<SDKMessage, { type: "result" }>;
    expect(claudeStartupFailure(result)).toEqual({
      reason: "provider_not_allowed",
      message: "Your organization's Claude Code settings don't allow this chat's API provider. Choose an allowed backend or ask your administrator.",
    });
    expect(claudeSessionUnavailable(result)).toBe(false);
  });

  it.each([
    ["org_config_required_unavailable", "Claude Code couldn't load the configuration your organization requires. Check your connection and try again."],
    ["org_config_refused", "Your organization's Claude Code configuration doesn't allow this run. Ask your administrator."],
  ] as const)("explains the organization configuration gate %s", (reason, message) => {
    const result = failedResult({
      startup_failure_reason: reason,
      errors: ["Organization configuration gate"],
    }) as Extract<SDKMessage, { type: "result" }>;
    expect(claudeStartupFailure(result)).toEqual({ reason, message });
    expect(claudeSessionUnavailable(result)).toBe(false);
  });

  it.each([
    [savedSessionId, true],
    [undefined, false],
  ] as const)("marks a missing conversation as an unavailable session only when resuming (%s)", async (sessionId, unavailable) => {
    const root = portableFixtureRoot("Claude missing session");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield missingSession;
      })()),
    });
    const result = await harness.start({
      input: nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-missing-session",
        cwd: root,
        prompt: "Continue",
        interactionMode: "build",
        access: "supervised",
        ...(sessionId ? { sessionId } : {}),
      }),
      executable: process.execPath,
      environment: {},
      providerNativeToolsAvailable: true,
    }).result;
    expect(result).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { terminalEvent: "result/error_during_execution" },
    });
    expect(result.failure?.sessionUnavailable).toBe(unavailable ? true : undefined);
  });

  it("answers from a fresh Claude session after the saved one is missing", async () => {
    const root = portableFixtureRoot("Claude session fallback");
    roots.push(root);
    const launches: Array<Options | undefined> = [];
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        launches.push(options);
        const resumed = options?.resume !== undefined;
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          if (resumed) {
            yield missingSession;
            return;
          }
          yield claudeSystem("init");
          yield claudeSuccessResult("Answered from a fresh session");
        })());
      },
    });
    const statuses: string[] = [];
    const fallback = () => ({ prompt: "Continue with the restored history." });
    const run = startHarnessWithFreshSessionFallback(harness, {
      input: nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-session-fallback",
        cwd: root,
        prompt: "Continue",
        interactionMode: "build",
        access: "supervised",
        sessionId: savedSessionId,
      }),
      executable: process.execPath,
      environment: {},
      providerNativeToolsAvailable: true,
      callbacks: {
        onEvent: (event) => {
          if (event.type === "status") statuses.push(event.status);
        },
      },
    }, fallback);

    await expect(run.result).resolves.toMatchObject({
      status: "completed",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
      text: "Answered from a fresh session",
    });
    expect(launches).toHaveLength(2);
    expect(launches[0]?.resume).toBe(savedSessionId);
    expect(launches[1]?.resume).toBeUndefined();
    expect(statuses).not.toContain("failed");
    expect(statuses.filter((status) => status === "starting")).toHaveLength(1);
    expect(statuses.at(-1)).toBe("completed");
  });
});
