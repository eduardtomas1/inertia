// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { claudeSuccessResult, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude plan mode permissions", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removePortableFixture(root)));
  });

  it("asks before plan-mode writes even with full access", async () => {
    const root = portableFixtureRoot("Claude plan mode writes");
    roots.push(root);
    const outcomes: Record<string, { permission?: PermissionResult; approvals: string[] }> = {};
    for (const interactionMode of ["plan", "build"] as const) {
      const outcome: { permission?: PermissionResult; approvals: string[] } = { approvals: [] };
      outcomes[interactionMode] = outcome;
      const harness = createClaudeAgentSdkHarness({
        createQuery: ({ options }) => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            outcome.permission = (await options?.canUseTool?.(
              "Write",
              { file_path: "plan.txt", content: "draft" },
              {
                signal: new AbortController().signal,
                toolUseID: `write-${interactionMode}`,
                requestId: `write-${interactionMode}`,
              },
            )) ?? undefined;
            yield claudeSuccessResult("Done", "completed");
          })(),
        ),
      });
      const run = harness.start({
        input: nativeProviderRunInput({
          providerId: "claude",
          conversationId: `claude-${interactionMode}-full-write`,
          cwd: root,
          prompt: "Plan the change.",
          interactionMode,
          access: "full",
        }),
        executable: process.execPath,
        environment: {},
        providerNativeToolsAvailable: true,
        callbacks: {
          onEvent: (event) => {
            if (event.type !== "extension" || event.event.type !== "approval") return;
            outcome.approvals.push(event.event.request.title);
            if (run.extension.kind === "claude-agent-sdk") {
              run.extension.respondToApproval(event.event.request.requestId, "deny");
            }
          },
        },
      });
      await expect(run.result).resolves.toMatchObject({ status: "completed" });
    }

    expect(outcomes.plan).toEqual({
      approvals: ["Claude wants to use Write"],
      permission: expect.objectContaining({ behavior: "deny", message: "User declined tool execution." }),
    });
    expect(outcomes.build).toEqual({
      approvals: [],
      permission: { behavior: "allow", updatedInput: { file_path: "plan.txt", content: "draft" } },
    });
  });
});
