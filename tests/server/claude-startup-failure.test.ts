// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { CLAUDE_PROTOCOL_SESSION_ID, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
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
      HTTPS_PROXY: "invalid",
    });
  });
});
