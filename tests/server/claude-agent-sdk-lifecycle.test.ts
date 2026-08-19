import { afterEach, describe, expect, it } from "vitest";

import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import {
  portableFixtureRoot,
  removePortableFixture,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude Agent SDK lifecycle isolation", () => {
  const roots: string[] = [];
  afterEach(async () =>
    await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("settles a final SDK result without waiting for an optional idle edge", async () => {
    const root = portableFixtureRoot("Claude SDK terminal result");
    roots.push(root);
    let releaseIterator!: () => void;
    const iteratorReleased = new Promise<void>((resolve) => {
      releaseIterator = resolve;
    });
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSuccessResult("Sonnet finished", "completed");
          await iteratorReleased;
        })(),
      ),
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const run = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-result-without-idle",
      cwd: root,
      prompt: "Finish without an idle edge",
      interactionMode: "build",
      access: "supervised",
    }));

    const outcome = await Promise.race([
      run.then(() => "settled" as const),
      new Promise<"stalled">((resolve) =>
        setTimeout(() => resolve("stalled"), 100)),
    ]);
    releaseIterator();

    expect(outcome).toBe("settled");
    await expect(run).resolves.toMatchObject({
      status: "completed",
      text: "Sonnet finished",
    });
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("keeps child-owned text, thinking, and tools out of the parent while preserving nested traces", async () => {
    const root = portableFixtureRoot("Claude SDK child projection isolation");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield {
            type: "assistant",
            session_id: "45454545-4545-4545-8545-454545454545",
            parent_tool_use_id: null,
            message: {
              content: [{
                type: "tool_use",
                id: "tool-parent-agent",
                name: "Agent",
                input: {
                  subagent_type: "researcher",
                  description: "Inspect child ownership",
                },
              }],
            },
          } as unknown as SDKMessage;
          yield claudeSystem("task_started", {
            task_id: "task-parent-agent",
            tool_use_id: "tool-parent-agent",
            description: "Inspect child ownership",
            subagent_type: "researcher",
          });
          yield {
            type: "stream_event",
            session_id: "child-session-must-not-escape",
            parent_tool_use_id: "tool-parent-agent",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "child reasoning" },
            },
          } as unknown as SDKMessage;
          yield {
            type: "stream_event",
            session_id: "child-session-must-not-escape",
            parent_tool_use_id: "tool-parent-agent",
            event: {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: "child streamed text" },
            },
          } as unknown as SDKMessage;
          yield {
            type: "assistant",
            session_id: "child-session-must-not-escape",
            parent_tool_use_id: "tool-parent-agent",
            message: {
              content: [
                { type: "text", text: "child assistant snapshot" },
                { type: "thinking", thinking: "child snapshot reasoning" },
                {
                  type: "tool_use",
                  id: "tool-child-agent",
                  name: "Task",
                  input: {
                    subagent_type: "reviewer",
                    prompt: "Review inside the child",
                  },
                },
                {
                  type: "tool_use",
                  id: "tool-child-bash",
                  name: "Bash",
                  input: { command: "printf child" },
                },
              ],
            },
          } as unknown as SDKMessage;
          yield claudeSystem("task_started", {
            task_id: "task-child-agent",
            tool_use_id: "tool-child-agent",
            description: "Review inside the child",
            subagent_type: "reviewer",
          });
          yield {
            type: "user",
            session_id: "child-session-must-not-escape",
            parent_tool_use_id: "tool-parent-agent",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-child-agent",
                  content: "nested result",
                },
                {
                  type: "tool_result",
                  tool_use_id: "tool-child-bash",
                  content: "child command output",
                },
              ],
            },
            tool_use_result: {
              status: "completed",
              agentId: "agent-child",
              agentType: "reviewer",
              content: [{ type: "text", text: "Nested review complete" }],
            },
          } as unknown as SDKMessage;
          yield claudeSystem("task_notification", {
            task_id: "task-parent-agent",
            tool_use_id: "tool-parent-agent",
            status: "completed",
            output_file: "/tmp/task-parent-agent",
            summary: "Parent delegate complete",
          });
          // Empty parent text is not output and must not suppress the result.
          yield {
            type: "assistant",
            session_id: "45454545-4545-4545-8545-454545454545",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "" }] },
          } as unknown as SDKMessage;
          yield claudeSuccessResult("Parent final result", "completed");
        })(),
      ),
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const textEvents: string[] = [];
    const reasoning: string[] = [];
    const sessions: string[] = [];
    const activities: Array<{ activityId?: string; label: string }> = [];
    const traces: Array<{
      parentProviderToolUseId: string | null;
      providerTaskId: string | null;
      status: string;
    }> = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-child-projection-isolation",
      cwd: root,
      prompt: "Keep child output isolated",
      interactionMode: "build",
      access: "full",
    }), {
      onText: ({ text }) => textEvents.push(text),
      onReasoning: ({ text }) => reasoning.push(text),
      onSession: ({ sessionId }) => sessions.push(sessionId),
      onActivity: ({ activityId, label }) =>
        activities.push({ activityId, label }),
      onSubagent: ({ parentProviderToolUseId, providerTaskId, status }) => {
        traces.push({ parentProviderToolUseId, providerTaskId, status });
      },
    })).resolves.toMatchObject({
      status: "completed",
      text: "Parent final result",
    });
    expect(textEvents).toEqual(["Parent final result"]);
    expect(reasoning).toEqual([]);
    expect(sessions).not.toContain("child-session-must-not-escape");
    expect(activities).toEqual([
      { activityId: "tool-parent-agent", label: "Agent" },
    ]);
    expect(traces).toContainEqual({
      parentProviderToolUseId: "tool-parent-agent",
      providerTaskId: "task-child-agent",
      status: "spawned",
    });
    expect(traces).toContainEqual({
      parentProviderToolUseId: "tool-parent-agent",
      providerTaskId: "task-child-agent",
      status: "completed",
    });
  });

  it("waits for the successful result correlated to an admitted follow-up", async () => {
    const root = portableFixtureRoot("Claude SDK correlated follow-up");
    roots.push(root);
    const prompts: SDKUserMessage[] = [];
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[
            Symbol.asyncIterator
          ]();
          const initial = (await iterator.next()).value!;
          prompts.push(initial);
          const followUp = (await iterator.next()).value!;
          prompts.push(followUp);
          yield {
            ...claudeSuccessResult("Initial result", "completed"),
            user_message_uuid: initial.uuid,
          } as SDKMessage;
          yield {
            ...claudeSuccessResult("Follow-up result", "completed"),
            user_message_uuid: followUp.uuid,
          } as SDKMessage;
        })(),
      ),
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    let followUpAccepted: Promise<boolean> | null = null;

    const run = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-correlated-follow-up",
      cwd: root,
      prompt: "Handle the first turn",
      interactionMode: "build",
      access: "full",
    }), {
      onStatus: (event) => {
        if (event.status !== "running" || followUpAccepted) return;
        followUpAccepted = manager.steer(event.conversationId, {
          content: "Handle this admitted follow-up too",
          imagePaths: [],
        }, { runId: event.runId, turnId: event.turnId! });
      },
    });

    await expect(run).resolves.toMatchObject({
      status: "completed",
      text: "Follow-up result",
    });
    await expect(followUpAccepted).resolves.toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.uuid).toEqual(expect.any(String));
    expect(prompts[1]?.uuid).toEqual(expect.any(String));
    expect(prompts[1]?.uuid).not.toBe(prompts[0]?.uuid);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("fails explicitly when an accepted follow-up result cannot be correlated", async () => {
    const root = portableFixtureRoot("Claude SDK uncorrelated follow-up");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[
            Symbol.asyncIterator
          ]();
          await iterator.next();
          await iterator.next();
          yield claudeSuccessResult("Uncorrelated result", "completed");
        })(),
      ),
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    let followUpAccepted: Promise<boolean> | null = null;

    const run = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-uncorrelated-follow-up",
      cwd: root,
      prompt: "Handle the first turn",
      interactionMode: "build",
      access: "full",
    }), {
      onStatus: (event) => {
        if (event.status !== "running" || followUpAccepted) return;
        followUpAccepted = manager.steer(event.conversationId, {
          content: "This accepted follow-up must be accounted for",
          imagePaths: [],
        }, { runId: event.runId, turnId: event.turnId! });
      },
    });

    await expect(run).resolves.toMatchObject({
      status: "failed",
      error: "Claude returned a successful result without correlating an accepted follow-up.",
    });
    await expect(followUpAccepted).resolves.toBe(true);
    expect(manager.activeConversationIds()).toEqual([]);
  });
});
