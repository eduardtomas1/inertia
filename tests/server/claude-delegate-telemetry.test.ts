// @inertia-test-suite portable
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeBackgroundTasks,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude delegated task telemetry", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("forwards structured delegated task telemetry without a usage suffix in progress", async () => {
    const root = portableFixtureRoot("Claude SDK delegate telemetry");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield {
            type: "assistant",
            uuid: "assistant-delegate-telemetry",
            session_id: CLAUDE_PROTOCOL_SESSION_ID,
            parent_tool_use_id: null,
            message: {
              id: "api-delegate-telemetry",
              type: "message",
              role: "assistant",
              model: "claude-test",
              content: [{
                type: "tool_use",
                id: "tool-agent-telemetry",
                name: "Agent",
                input: {
                  subagent_type: "researcher",
                  description: "Measure the delegate",
                  model: "sonnet",
                },
              }],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          } as unknown as SDKMessage;
          yield claudeBackgroundTasks(["agent-telemetry"]);
          yield claudeSystem("task_started", {
            task_id: "agent-telemetry",
            tool_use_id: "tool-agent-telemetry",
            description: "Measure the delegate",
            subagent_type: "researcher",
          });
          yield claudeSystem("task_progress", {
            task_id: "agent-telemetry",
            tool_use_id: "tool-agent-telemetry",
            description: "Measure the delegate",
            usage: { total_tokens: 900, tool_uses: 2, duration_ms: 1_500 },
            last_tool_name: "Read",
          });
          yield {
            type: "tool_progress",
            uuid: "progress-agent-telemetry",
            session_id: CLAUDE_PROTOCOL_SESSION_ID,
            task_id: "agent-telemetry",
            tool_use_id: "child-grep-telemetry",
            tool_name: "Grep",
            parent_tool_use_id: "tool-agent-telemetry",
            elapsed_time_seconds: 2,
          } as unknown as SDKMessage;
          yield claudeBackgroundTasks([]);
          yield claudeSystem("task_notification", {
            task_id: "agent-telemetry",
            tool_use_id: "tool-agent-telemetry",
            status: "completed",
            output_file: "/tmp/agent-telemetry",
            summary: "Delegate measured",
            usage: { total_tokens: 1_800, tool_uses: 3, duration_ms: 2_500 },
          });
          yield claudeSuccessResult("Parent finished", "completed");
        })(),
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const traces: Array<Record<string, unknown>> = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-delegate-telemetry",
      cwd: root,
      prompt: "Report delegate telemetry",
      interactionMode: "build",
      access: "supervised",
    }), {
      onSubagent: ({
        sequence,
        status,
        progress,
        model,
        activity,
        usage,
        toolUseCount,
        durationMs,
      }) => {
        traces.push({
          sequence,
          status,
          progress,
          model,
          activity,
          totalTokens: usage?.totalTokens,
          toolUseCount,
          durationMs,
        });
      },
    })).resolves.toMatchObject({
      status: "completed",
      text: "Parent finished",
    });
    expect(traces).toEqual([
      {
        sequence: 1,
        status: "spawned",
        progress: null,
        model: "sonnet",
        activity: undefined,
        totalTokens: undefined,
        toolUseCount: undefined,
        durationMs: undefined,
      },
      {
        sequence: 2,
        status: "running",
        progress: "Read",
        model: "sonnet",
        activity: "Read",
        totalTokens: 900,
        toolUseCount: 2,
        durationMs: 1_500,
      },
      {
        sequence: 3,
        status: "running",
        progress: "Grep · 2 seconds elapsed",
        model: "sonnet",
        activity: "Grep",
        totalTokens: undefined,
        toolUseCount: undefined,
        durationMs: undefined,
      },
      {
        sequence: 4,
        status: "completed",
        progress: null,
        model: "sonnet",
        activity: undefined,
        totalTokens: 1_800,
        toolUseCount: 3,
        durationMs: 2_500,
      },
    ]);
  });
});
