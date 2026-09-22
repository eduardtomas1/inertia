// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it.each(["refused", "cancelled", "discarded", "eof"] as const)("fails instead of accepting a notification result when the new prompt ends with %s", async (ending) => {
    const root = portableFixtureRoot("Claude unanswered queued prompt");
    roots.push(root);
    let readPastTerminal!: () => void;
    const unexpectedRead = new Promise<"read-past-terminal">((resolve) => {
      readPastTerminal = () => resolve("read-past-terminal");
    });
    let releaseIterator!: () => void;
    const iteratorReleased = new Promise<void>((resolve) => { releaseIterator = resolve; });
    const close = vi.fn();
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        const promptUuid = (await iterator.next()).value.uuid as string;
        const frame = (state: string) => ({
          type: "command_lifecycle", command_uuid: promptUuid, state,
          uuid: `lifecycle-${state}`, session_id: CLAUDE_PROTOCOL_SESSION_ID,
        }) as unknown as SDKMessage;
        yield frame("queued");
        yield claudeSystem("init");
        yield { ...claudeSuccessResult(""), num_turns: 0, origin: { kind: "task-notification" } } as SDKMessage;
        if (ending !== "eof") {
          yield frame(ending);
          // A persistent SDK stream need not emit another result or EOF.
          // Detect an extra read immediately, without a timing-dependent race.
          readPastTerminal();
          await iteratorReleased;
        }
      })(), { close }),
    });
    const run = harness.start({
      input: nativeProviderRunInput({ providerId: "claude", conversationId: "unanswered-queued-prompt",
        cwd: root, prompt: "Reply with exactly PONG.", interactionMode: "build", access: "supervised" }),
      executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
    });
    try {
      expect(await Promise.race([
        run.result.then(() => "settled"),
        unexpectedRead,
      ])).toBe("settled");
      await expect(run.result).resolves.toMatchObject({
        status: "failed", text: "", cleanupConfirmed: true,
        failure: { terminalEvent: `lifecycle/${ending === "eof" ? "missing-result" : `prompt-${ending}`}` },
      });
      if (ending === "discarded") {
        await expect(run.result).resolves.toMatchObject({
          error: "Claude discarded the request before returning an answer.",
        });
      }
      expect(close).toHaveBeenCalledOnce();
    } finally {
      releaseIterator();
      await run.result;
    }
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

  it("answers a resumed prompt even when the leftover notification's empty result echoes it", async () => {
    const root = portableFixtureRoot("Claude echoed notification acknowledgement");
    roots.push(root);
    let promptMessage: SDKUserMessage | undefined;
    const close = vi.fn();
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        promptMessage = (await iterator.next()).value;
        const promptUuid = promptMessage!.uuid as string;
        const frame = (state: string) => ({
          type: "command_lifecycle", command_uuid: promptUuid, state,
          uuid: `lifecycle-${state}`, session_id: CLAUDE_PROTOCOL_SESSION_ID,
        }) as unknown as SDKMessage;
        yield claudeSystem("task_notification", {
          task_id: "leftover-shell", status: "stopped", output_file: "",
          summary: "Background shell command didn't finish before the previous session ended",
        });
        yield frame("queued");
        yield claudeSystem("init");
        yield frame("started");
        yield {
          ...claudeSuccessResult(""),
          num_turns: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          origin: { kind: "task-notification" },
          user_message_uuid: promptUuid,
          user_message_uuids: [promptUuid],
        } as SDKMessage;
        yield claudeSystem("init");
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
      })(), { close }),
    });
    const run = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude", conversationId: "claude-echoed-notification-ack",
        cwd: root, prompt: "Reply with exactly PONG.", interactionMode: "build", access: "supervised",
      }),
      executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
    });

    await expect(run.result).resolves.toMatchObject({ status: "completed", text: "PONG" });
    expect(promptMessage?.origin).toEqual({ kind: "human" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails visibly when Claude completes the resumed prompt without answering it", async () => {
    const root = portableFixtureRoot("Claude unanswered resumed prompt");
    roots.push(root);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const harness = createClaudeAgentSdkHarness({
      terminalSubagentDrainTimeoutMs: 25,
      createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        const promptUuid = (await iterator.next()).value.uuid as string;
        const frame = (state: string) => ({
          type: "command_lifecycle", command_uuid: promptUuid, state,
          uuid: `lifecycle-${state}`, session_id: CLAUDE_PROTOCOL_SESSION_ID,
        }) as unknown as SDKMessage;
        yield frame("queued");
        yield claudeSystem("init");
        yield frame("started");
        yield {
          ...claudeSuccessResult(""),
          num_turns: 0,
          origin: { kind: "task-notification" },
          user_message_uuid: promptUuid,
          user_message_uuids: [promptUuid],
        } as SDKMessage;
        yield frame("completed");
        await released;
      })(), { close: release }),
    });
    const run = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude", conversationId: "claude-unanswered-resumed-prompt",
        cwd: root, prompt: "Reply with exactly PONG.", interactionMode: "build", access: "supervised",
      }),
      executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
    });

    await expect(run.result).resolves.toMatchObject({
      status: "failed", text: "", cleanupConfirmed: true,
      error: "Claude finished the request without returning an answer.",
      failure: { terminalEvent: "lifecycle/prompt-unanswered" },
    });
  });

  it.each([
    { prompt: "Reply with exactly PONG.", localCommand: undefined, status: "failed" },
    { prompt: "/clear", localCommand: "clear", status: "completed" },
  ])("does not complete $prompt silently on an empty zero-turn result", async ({ prompt, localCommand, status }) => {
    const root = portableFixtureRoot("Claude empty zero-turn result");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield claudeSystem("init");
        yield {
          ...claudeSuccessResult(""),
          num_turns: 0,
          ...(localCommand ? { local_command: localCommand } : {}),
        } as SDKMessage;
      })()),
    });
    const run = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude", conversationId: "claude-empty-zero-turn-result",
        cwd: root, prompt, interactionMode: "build", access: "supervised",
      }),
      executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
    });

    await expect(run.result).resolves.toMatchObject(status === "failed"
      ? {
          status, text: "",
          error: "Claude finished the request without returning an answer.",
          failure: { terminalEvent: "result/unanswered" },
        }
      : { status, text: "" });
  });
});
