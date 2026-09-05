// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeBackgroundTasks,
  claudeSessionState,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import {
  portableFixtureRoot,
  removePortableFixture,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage;
}

describe("Claude delegated parent resume", () => {
  const roots: string[] = [];

  afterEach(async () =>
    await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("waits for a fresh parent result after a provisional completed result", async () => {
    const root = portableFixtureRoot("Claude SDK late delegate notification");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield claudeBackgroundTasks(["agent-late"]);
          yield claudeSystem("task_started", {
            task_id: "agent-late",
            tool_use_id: "tool-agent-late",
            description: "Inspect the final ordering",
            subagent_type: "researcher",
          });
          yield sdkMessage({
            type: "assistant",
            session_id: CLAUDE_PROTOCOL_SESSION_ID,
            parent_tool_use_id: null,
            message: {
              content: [{
                type: "text",
                text: "Waiting for delegated work. ",
              }],
            },
          });
          yield claudeSuccessResult(
            "Waiting for delegated work.",
            "completed",
          );
          yield claudeBackgroundTasks([]);
          yield claudeSystem("task_notification", {
            task_id: "agent-late",
            tool_use_id: "tool-agent-late",
            status: "completed",
            output_file: "/tmp/agent-late",
            summary: "Final ordering inspected",
          });
          yield claudeSessionState("running");
          yield claudeSuccessResult(
            "Parent incorporated the delegate result.",
            "completed",
          );
        })(),
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const traces: Array<{ status: string; result: string | null }> = [];
    const textEvents: string[] = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-late-delegate-notification",
      cwd: root,
      prompt: "Inspect the final ordering",
      interactionMode: "build",
      access: "supervised",
    }), {
      onText: ({ text }) => textEvents.push(text),
      onSubagent: ({ status, result }) => {
        traces.push({ status, result });
      },
    })).resolves.toMatchObject({
      status: "completed",
      text: "Parent incorporated the delegate result.",
    });
    expect(textEvents).toEqual([
      "Waiting for delegated work. ",
      "Parent incorporated the delegate result.",
    ]);
    expect(traces).toEqual([
      { status: "spawned", result: null },
      { status: "completed", result: "Final ordering inspected" },
    ]);
  });

  it("retains an async Agent receipt until the parent resumes", async () => {
    const root = portableFixtureRoot("Claude SDK async delegate receipt");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield sdkMessage({
            type: "assistant",
            session_id: CLAUDE_PROTOCOL_SESSION_ID,
            parent_tool_use_id: null,
            message: {
              content: [{
                type: "tool_use",
                id: "tool-async-agent",
                name: "Agent",
                input: {
                  subagent_type: "researcher",
                  description: "Research asynchronously",
                },
              }],
            },
          });
          yield sdkMessage({
            type: "user",
            session_id: CLAUDE_PROTOCOL_SESSION_ID,
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: "tool-async-agent",
                content: "Async agent launched successfully.",
              }],
            },
            tool_use_result: {
              status: "async_launched",
              agentId: "agent-async",
              agentType: "researcher",
              description: "Research asynchronously",
            },
          });
          yield claudeSuccessResult(
            "The async agent is still working.",
            "completed",
          );
          yield claudeSystem("task_started", {
            task_id: "task-async-agent",
            tool_use_id: "tool-async-agent",
            description: "Research asynchronously",
            subagent_type: "researcher",
            is_backgrounded: true,
          });
          yield claudeSystem("task_notification", {
            task_id: "task-async-agent",
            tool_use_id: "tool-async-agent",
            status: "completed",
            summary: "Async research complete",
          });
          yield claudeSessionState("running");
          yield claudeSuccessResult(
            "Parent used the async research.",
            "completed",
          );
        })(),
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const traceStatuses: string[] = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-async-delegate-receipt",
      cwd: root,
      prompt: "Research asynchronously",
      interactionMode: "build",
      access: "supervised",
    }), {
      onSubagent: ({ status }) => traceStatuses.push(status),
    })).resolves.toMatchObject({
      status: "completed",
      text: "Parent used the async research.",
    });
    expect(traceStatuses).toEqual(["running", "spawned", "completed"]);
  });

  it("waits for the authoritative roster after an earlier terminal task edge", async () => {
    const root = portableFixtureRoot("Claude SDK delayed empty roster");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      terminalSubagentDrainTimeoutMs: 10,
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield claudeBackgroundTasks(["agent-delayed-roster"]);
          yield claudeSystem("task_started", {
            task_id: "agent-delayed-roster",
            tool_use_id: "tool-delayed-roster",
            description: "Wait for the roster level",
            subagent_type: "researcher",
          });
          yield claudeSuccessResult(
            "Waiting for authoritative completion.",
            "completed",
          );
          yield claudeSystem("task_notification", {
            task_id: "agent-delayed-roster",
            tool_use_id: "tool-delayed-roster",
            status: "completed",
            summary: "Typed task edge arrived first",
          });

          await new Promise((resolve) => setTimeout(resolve, 30));
          yield claudeBackgroundTasks([]);
          yield claudeSessionState("running");
          yield claudeSuccessResult(
            "Parent resumed after the roster cleared.",
            "completed",
          );
        })(),
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-delayed-empty-roster",
      cwd: root,
      prompt: "Respect the authoritative roster",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "completed",
      text: "Parent resumed after the roster cleared.",
    });
  });
});
