// @inertia-test-suite portable
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeBackgroundTasks,
  claudeSuccessResult,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude exit after the parent resumed", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });

  it("reports a mid-turn exit instead of a missed parent resume", async () => {
    const root = portableFixtureRoot("Claude SDK exit after parent resumed");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      terminalSubagentDrainTimeoutMs: 25,
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield claudeBackgroundTasks(["shell-1"]);
          yield claudeSuccessResult("Waiting for the shell", "completed");
          yield claudeBackgroundTasks([]);
          // The parent resumes with root output, then the CLI exits mid-turn.
          yield {
            type: "assistant",
            parent_tool_use_id: null,
            session_id: CLAUDE_PROTOCOL_SESSION_ID,
            uuid: "assistant-resumed",
            message: { role: "assistant", content: [{ type: "text", text: "Checking" }] },
          } as unknown as SDKMessage;
        })(),
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-exit-after-parent-resumed",
      cwd: root,
      prompt: "Resume after the shell, then exit",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "Claude Agent SDK exited without a final result.",
      failure: { terminalEvent: "lifecycle/missing-result" },
    });
  });
});
