// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { claudeSuccessResult, claudeSystem, CLAUDE_PROTOCOL_SESSION_ID, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude resumed prompts", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => removePortableFixture(root)));
  });

  it.each([true, false])("answers a prompt that Claude Code queued behind a leftover task notification (lifecycle frames: %s)", async (withLifecycleFrames) => {
    const root = portableFixtureRoot("Claude resumed queued prompt");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        const promptUuid = (await iterator.next()).value.uuid as string;
        const frame = (state: string) => ({
          type: "command_lifecycle",
          command_uuid: promptUuid,
          state,
          uuid: `lifecycle-${state}`,
          session_id: CLAUDE_PROTOCOL_SESSION_ID,
        }) as unknown as SDKMessage;
        yield claudeSystem("task_notification", { task_id: "leftover-shell", status: "stopped", output_file: "", summary: "" });
        if (withLifecycleFrames) yield frame("queued");
        yield claudeSystem("init");
        yield {
          ...claudeSuccessResult(""),
          num_turns: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          ...(withLifecycleFrames ? {} : { origin: { kind: "task-notification" } }),
        } as SDKMessage;
        if (withLifecycleFrames) yield frame("started");
        yield {
          type: "assistant",
          uuid: "assistant-pong",
          session_id: CLAUDE_PROTOCOL_SESSION_ID,
          parent_tool_use_id: null,
          message: {
            id: "api-pong", type: "message", role: "assistant", model: "claude-test",
            content: [{ type: "text", text: "PONG" }],
            stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 },
          },
        } as unknown as SDKMessage;
        yield {
          ...claudeSuccessResult("PONG", "completed"),
          user_message_uuid: promptUuid,
          user_message_uuids: [promptUuid],
        } as SDKMessage;
      })()),
    });
    const run = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-resumed-queued-prompt",
        cwd: root,
        prompt: "Reply with exactly PONG.",
        interactionMode: "build",
        access: "supervised",
      }),
      executable: process.execPath,
      environment: {},
      providerNativeToolsAvailable: true,
    });

    await expect(run.result).resolves.toMatchObject({ status: "completed", text: "PONG" });
  });
});
