// @inertia-test-suite portable
import type { Options as ClaudeOptions, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, it } from "vitest";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { fixtureClaudeQuery, claudeSuccessResult } from "../helpers/claude-agent-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";
const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));
  it("disables native tools and inherited MCP configuration for report chats", async () => {
    const root = portableFixtureRoot("Claude native tools disabled");
    roots.push(root);
    let capturedOptions: ClaudeOptions | undefined;
    let permission: PermissionResult | undefined;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        capturedOptions = options;
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            permission = (await options?.canUseTool?.(
              "Bash",
              { command: "touch must-not-run" },
              {
                signal: new AbortController().signal,
                toolUseID: "native-tool-without-authority",
                requestId: "native-tool-without-authority",
              },
            )) ?? undefined;
            yield claudeSuccessResult("Text only", "completed");
          })(),
        );
      },
    });
    const run = harness.start({
      input: { ...nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-native-tools-disabled",
        cwd: root,
        prompt: "Answer without tools.",
        interactionMode: "build",
        access: "supervised",
      }), toolRestriction: "none" },
      executable: process.execPath,
      environment: {},
      providerNativeToolsAvailable: false,
    });

    await expect(run.result).resolves.toMatchObject({
      status: "completed",
      text: "Text only",
    });
    expect(capturedOptions?.tools).toEqual([]);
    expect(capturedOptions?.mcpServers).toEqual({});
    expect(capturedOptions?.strictMcpConfig).toBe(true);
    expect(capturedOptions?.settingSources).toEqual([]);
    expect(permission).toEqual({
      behavior: "deny",
      message: "Provider-native tools are unavailable for this exact backend and model.",
    });
  });

it("rejects report execution on a harness without native tool denial before launching a process", async () => {
  const { ProviderManager } = await import("../../src/server/providers");
  const manager = ProviderManager.createForTests();
  const input = { ...nativeProviderRunInput({ providerId: "codex", conversationId: "report-no-tools", cwd: process.cwd(), prompt: "Bounded assessment", interactionMode: "plan", access: "supervised" }), toolRestriction: "none" as const };
  expect(() => manager.run(input)).toThrow("cannot enforce a report chat without tools");
  expect(manager.activeConversationIds()).toEqual([]);
});
