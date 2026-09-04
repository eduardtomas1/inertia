// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  createAgentHarnessEmitter,
  type AgentHarnessEvent,
} from "../../src/server/provider/agent-harness";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  ClaudeMessageProjector,
  MAX_CLAUDE_STREAM_CORRELATION_BLOCKS,
  MAX_CLAUDE_STREAM_CORRELATION_CHARS,
} from "../../src/server/provider/claude-message-projector";
import { CappedProviderBuffer } from "../../src/server/provider/io";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
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

function streamMessage(
  uuid: string,
  event: Record<string, unknown>,
  parentToolUseId: string | null = null,
): SDKMessage {
  return sdkMessage({
    type: "stream_event",
    uuid,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    parent_tool_use_id: parentToolUseId,
    event,
  });
}

function assistantMessage(input: {
  uuid: string;
  apiMessageId: string;
  content: unknown[];
  error?: string;
  supersedes?: string[];
  aborted?: true;
  parentToolUseId?: string | null;
}): SDKMessage {
  return sdkMessage({
    type: "assistant",
    uuid: input.uuid,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    parent_tool_use_id: input.parentToolUseId ?? null,
    message: {
      id: input.apiMessageId,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: input.content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    ...(input.error ? { error: input.error } : {}),
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    ...(input.aborted ? { aborted: true } : {}),
  });
}

function unitProjector(events?: AgentHarnessEvent[]): ClaudeMessageProjector {
  return new ClaudeMessageProjector({
    emitter: createAgentHarnessEmitter(
      "claude",
      "unit-projector",
      events ? { onEvent: (event) => events.push(event) } : undefined,
      "unit-projector-run",
      "unit-projector-turn",
    ),
    text: new CappedProviderBuffer(8 * 1024 * 1024),
    usesNativeAnthropic: false,
    contextUsage: () => undefined,
    acceptContextUsage: () => undefined,
    refreshContextUsage: () => undefined,
  });
}

describe("Claude Agent SDK message projection", () => {
  const roots: string[] = [];
  afterEach(async () =>
    await Promise.all(roots.splice(0).map(removePortableFixture)));

  async function run(messages: readonly SDKMessage[]): Promise<{
    events: AgentHarnessEvent[];
    result: Awaited<ReturnType<ReturnType<typeof createClaudeAgentSdkHarness>["start"]>["result"]>;
  }> {
    const root = portableFixtureRoot("Claude SDK message projection");
    roots.push(root);
    const events: AgentHarnessEvent[] = [];
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          for (const message of messages) yield message;
        })(),
      ),
    });
    const providerRun = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-message-projection",
        cwd: root,
        prompt: "Project the SDK messages",
        interactionMode: "build",
        access: "supervised",
      }),
      executable: process.execPath,
      environment: {},
      callbacks: { onEvent: (event) => events.push(event) },
    });
    return { events, result: await providerRun.result };
  }

  it("projects runtime command lifecycle frames without failing the turn", async () => {
    const { events, result } = await run([
      sdkMessage({
        type: "command_lifecycle",
        command_uuid: "command-1",
        state: "queued",
        uuid: "lifecycle-1",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
      }),
      sdkMessage({
        type: "command_lifecycle",
        command_uuid: "command-1",
        state: "started",
        uuid: "lifecycle-2",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
      }),
      assistantMessage({
        uuid: "assistant-command-lifecycle",
        apiMessageId: "api-command-lifecycle",
        content: [{ type: "text", text: "Done" }],
      }),
      sdkMessage({
        type: "command_lifecycle",
        command_uuid: "command-1",
        state: "completed",
        uuid: "lifecycle-3",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
      }),
      sdkMessage({
        type: "command_lifecycle",
        command_uuid: "command-refused",
        state: "refused",
        uuid: "lifecycle-refused",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
      }),
      claudeSuccessResult("Done", "completed"),
    ]);

    expect(result).toMatchObject({ status: "completed", text: "Done" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      activityId: "claude:command:command-1",
      phase: "started",
      label: "Claude queued the request",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      activityId: "claude:command:command-1",
      phase: "completed",
      label: "Claude completed the request",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      activityId: "claude:command:command-refused",
      phase: "failed",
      label: "Claude refused the request",
      detail: "State: refused",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      label: "Claude sent an unsupported SDK update",
    }));
  });

  it("surfaces an unknown runtime frame without terminating the turn", async () => {
    const { events, result } = await run([
      sdkMessage({
        type: "future_runtime_notice",
        state: "started",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
        content: "must not be projected",
      }),
      assistantMessage({
        uuid: "assistant-after-unknown",
        apiMessageId: "api-after-unknown",
        content: [{ type: "text", text: "Still completed" }],
      }),
      claudeSuccessResult("Still completed", "completed"),
    ]);

    expect(result).toMatchObject({
      status: "completed",
      text: "Still completed",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      phase: "info",
      label: "Claude sent an unsupported SDK update",
      detail: expect.stringContaining("Type: future_runtime_notice"),
    }));
    expect(events.flatMap((event) =>
      event.type === "text" ? [event.text] : [])).not.toContain(
      "must not be projected",
    );
  });

  it("reconciles delta and snapshot blocks by API message identity", async () => {
    const firstAssistant = assistantMessage({
      uuid: "assistant-1",
      apiMessageId: "api-message-1",
      content: [
        { type: "thinking", thinking: "Thinking" },
        { type: "text", text: "Hello world" },
        {
          type: "tool_use",
          id: "tool-dedup",
          name: "Read",
          input: { file_path: "README.md" },
        },
      ],
    });
    const { events, result } = await run([
      streamMessage("partial-start", {
        type: "message_start",
        message: { id: "api-message-1" },
      }),
      streamMessage("partial-thinking-1", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Think" },
      }),
      streamMessage("partial-thinking-2", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "ing" },
      }),
      streamMessage("partial-text", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Hello " },
      }),
      firstAssistant,
      firstAssistant,
      assistantMessage({
        uuid: "assistant-2",
        apiMessageId: "api-message-2",
        content: [{ type: "text", text: " Again" }],
      }),
      claudeSuccessResult("Hello world Again", "completed"),
    ]);

    expect(result).toMatchObject({
      status: "completed",
      text: "Hello world Again",
    });
    expect(events.flatMap((event) =>
      event.type === "text" ? [event.text] : [])).toEqual([
      "Hello ",
      "world",
      " Again",
    ]);
    expect(events.flatMap((event) =>
      event.type === "extension"
      && event.extension === "claude-agent-sdk"
      && event.event.type === "reasoning-summary"
        ? [event.event.text]
        : [])).toEqual(["Think", "ing"]);
    expect(events.filter((event) =>
      event.type === "activity"
      && event.activityId === "tool-dedup"
      && event.phase === "started")).toHaveLength(1);
  });

  it("surfaces request retries, tool progress, warnings, and typed denials", async () => {
    const { events, result } = await run([
      claudeSystem("status", { status: "requesting" }),
      claudeSystem("api_retry", {
        attempt: 2,
        max_retries: 4,
        retry_delay_ms: 1_500,
        error_status: 529,
        error: "overloaded",
      }),
      assistantMessage({
        uuid: "assistant-tool",
        apiMessageId: "api-tool",
        content: [{
          type: "tool_use",
          id: "tool-progress",
          name: "Bash",
          input: { command: "npm test" },
        }],
      }),
      sdkMessage({
        type: "tool_progress",
        uuid: "progress-1",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
        parent_tool_use_id: null,
        tool_use_id: "tool-progress",
        tool_name: "Bash",
        elapsed_time_seconds: 30,
        heartbeat: true,
      }),
      claudeSystem("informational", {
        content: "The provider is still checking the workspace.",
        level: "warning",
      }),
      claudeSystem("permission_denied", {
        tool_name: "Bash",
        tool_use_id: "tool-progress",
        decision_reason_type: "rule",
        decision_reason: "Command is outside the allowed policy.",
        message: "Permission denied.",
      }),
      claudeSystem("local_command_output", { content: "Command summary" }),
      claudeSuccessResult("Command summary", "completed"),
    ]);
    const activities = events.flatMap((event) =>
      event.type === "activity" ? [event] : []);

    expect(result).toMatchObject({ status: "completed", text: "Command summary" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      status: "retrying",
      providerState: "system/api_retry attempt 2",
    }));
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: "started",
        label: "Claude is requesting a response",
      }),
      expect.objectContaining({
        phase: "info",
        label: "Claude API retry 2/4",
      }),
      expect.objectContaining({
        phase: "started",
        activityId: "tool-progress",
        detail: expect.stringContaining("Elapsed: 30 seconds"),
      }),
      expect.objectContaining({
        phase: "info",
        label: "Claude warning",
        detail: "The provider is still checking the workspace.",
      }),
      expect.objectContaining({
        phase: "failed",
        activityId: "tool-progress",
        detail: expect.stringContaining("Permission denied"),
      }),
      expect.objectContaining({
        phase: "completed",
        label: "Claude received a response",
      }),
    ]));
  });

  it("projects ExitPlanMode input through the provider plan contract", async () => {
    const { events, result } = await run([
      assistantMessage({
        uuid: "assistant-plan",
        apiMessageId: "api-plan",
        content: [{
          type: "tool_use",
          id: "tool-plan",
          name: "ExitPlanMode",
          input: { plan: "- Inspect provider output\n- Verify lifecycle" },
        }],
      }),
      claudeSuccessResult("Plan ready", "completed"),
    ]);

    expect(result).toMatchObject({ status: "completed", text: "Plan ready" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "extension",
      extension: "claude-agent-sdk",
      event: {
        type: "plan",
        explanation: "- Inspect provider output\n- Verify lifecycle",
        steps: [
          { step: "Inspect provider output", status: "pending" },
          { step: "Verify lifecycle", status: "pending" },
        ],
      },
    }));
  });

  it("uses typed assistant errors when the SDK exits without a result", async () => {
    const { events, result } = await run([
      assistantMessage({
        uuid: "assistant-rate-limit",
        apiMessageId: "api-rate-limit",
        content: [],
        error: "rate_limit",
      }),
    ]);

    expect(result).toMatchObject({
      status: "failed",
      error: "Claude reached an account rate limit.",
      failure: {
        reason: "provider-error",
        message: "Claude reached an account rate limit.",
        terminalEvent: "assistant/rate_limit",
        activityId: "assistant-rate-limit",
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      phase: "failed",
      label: "Claude response issue",
      activityId: "assistant-rate-limit",
    }));
  });

  it("surfaces an account hold as the typed cause of a missing result", async () => {
    const { events, result } = await run([
      assistantMessage({
        uuid: "assistant-account-hold",
        apiMessageId: "api-account-hold",
        content: [],
        error: "account_on_hold",
      }),
    ]);

    expect(result).toMatchObject({
      status: "failed",
      error: "Claude could not continue because the account is on hold.",
      failure: {
        reason: "provider-error",
        message: "Claude could not continue because the account is on hold.",
        terminalEvent: "assistant/account_on_hold",
        activityId: "assistant-account-hold",
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      phase: "failed",
      label: "Claude response issue",
      activityId: "assistant-account-hold",
    }));
  });

  it("uses an interrupted assistant as the typed cause of a missing result", async () => {
    const { events, result } = await run([
      assistantMessage({
        uuid: "assistant-aborted",
        apiMessageId: "api-aborted",
        content: [{ type: "text", text: "Partial" }],
        aborted: true,
      }),
    ]);

    expect(result).toMatchObject({
      status: "failed",
      error: "Claude's response was interrupted before completion.",
      failure: {
        reason: "provider-error",
        terminalEvent: "assistant/aborted",
        activityId: "assistant-aborted",
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      phase: "failed",
      label: "Claude response was interrupted",
      activityId: "assistant-aborted",
    }));
  });

  it("maps terminal SDK result subtypes to structured provider failures", async () => {
    const { result } = await run([sdkMessage({
      type: "result",
      subtype: "error_max_turns",
      uuid: "result-max-turns",
      session_id: CLAUDE_PROTOCOL_SESSION_ID,
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 100,
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
      errors: [],
    })]);

    expect(result).toMatchObject({
      status: "failed",
      error: "Claude reached the maximum number of agent turns.",
      failure: {
        reason: "provider-error",
        message: "Claude reached the maximum number of agent turns.",
        terminalEvent: "result/error_max_turns",
      },
    });
  });

  it("keeps child progress and replay-only tool results out of the parent", async () => {
    const { events, result } = await run([
      sdkMessage({
        type: "tool_progress",
        uuid: "child-progress",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
        parent_tool_use_id: "parent-agent-tool",
        tool_use_id: "child-tool",
        tool_name: "Bash",
        elapsed_time_seconds: 30,
      }),
      sdkMessage({
        type: "user",
        uuid: "replayed-result",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
        parent_tool_use_id: null,
        isReplay: true,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "history-tool",
            content: "historical output",
          }],
        },
      }),
      claudeSuccessResult("Parent response", "completed"),
    ]);

    expect(result).toMatchObject({ status: "completed", text: "Parent response" });
    expect(events.some((event) =>
      event.type === "activity"
      && (event.activityId === "child-tool"
        || event.activityId === "history-tool"))).toBe(false);
  });

  it("returns the replacement result after a refusal supersedes streamed text", async () => {
    const { events, result } = await run([
      streamMessage("refused-partial", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Refused partial" },
      }),
      assistantMessage({
        uuid: "replacement",
        apiMessageId: "replacement-api",
        supersedes: ["refused-partial"],
        content: [{ type: "text", text: "Replacement answer" }],
      }),
      claudeSuccessResult("Replacement answer", "completed"),
    ]);

    expect(result).toMatchObject({
      status: "completed",
      text: "Replacement answer",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      phase: "info",
      label: "Claude replaced an earlier response",
    }));
    expect(events.flatMap((event) =>
      event.type === "text" ? [event.text] : [])).toEqual([
      "Refused partial",
      "Replacement answer",
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "text-snapshot",
      text: "Replacement answer",
    }));
  });

  it("keeps a corrected snapshot authoritative after accepting a follow-up", async () => {
    const root = portableFixtureRoot("Claude SDK corrected follow-up");
    roots.push(root);
    const events: AgentHarnessEvent[] = [];
    let releaseInitialPrompt!: () => void;
    const initialPromptRead = new Promise<void>((resolve) => {
      releaseInitialPrompt = resolve;
    });
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[
            Symbol.asyncIterator
          ]();
          await iterator.next();
          releaseInitialPrompt();
          yield streamMessage("follow-up-stale", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Stale answer" },
          });
          const followUp = (await iterator.next()).value!;
          yield assistantMessage({
            uuid: "follow-up-replacement",
            apiMessageId: "follow-up-replacement-api",
            supersedes: ["follow-up-stale"],
            content: [{ type: "text", text: "Replacement answer" }],
          });
          yield {
            ...claudeSuccessResult("Replacement answer", "completed"),
            user_message_uuid: followUp.uuid,
          } as SDKMessage;
        })(),
      ),
    });
    const providerRun = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-corrected-follow-up",
        cwd: root,
        prompt: "Start the answer",
        interactionMode: "build",
        access: "supervised",
      }),
      executable: process.execPath,
      environment: {},
      callbacks: { onEvent: (event) => events.push(event) },
    });

    await initialPromptRead;
    expect(providerRun.extension.kind).toBe("claude-agent-sdk");
    if (providerRun.extension.kind !== "claude-agent-sdk") {
      throw new Error("Expected the Claude Agent SDK run extension.");
    }
    await expect(providerRun.extension.steer?.({
      content: "Correct that response.",
      imagePaths: [],
    })).resolves.toBe(true);

    await expect(providerRun.result).resolves.toMatchObject({
      status: "completed",
      text: "Replacement answer",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "text-snapshot",
      text: "Replacement answer",
    }));
  });

  it("uses the terminal result after a non-prefix snapshot correction", async () => {
    const { events, result } = await run([
      streamMessage("corrected-partial-start", {
        type: "message_start",
        message: { id: "corrected-api-message" },
      }),
      streamMessage("corrected-partial", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Stale partial" },
      }),
      assistantMessage({
        uuid: "corrected-message",
        apiMessageId: "corrected-api-message",
        content: [{ type: "text", text: "Corrected answer" }],
      }),
      claudeSuccessResult("Corrected answer", "completed"),
    ]);

    expect(result).toMatchObject({
      status: "completed",
      text: "Corrected answer",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "text-snapshot",
      text: "Corrected answer",
    }));
  });

  it("keeps local worker refusal fallback isolated from parent output", async () => {
    const { events, result } = await run([
      streamMessage("parent-partial", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Parent " },
      }),
      claudeSystem("model_refusal_fallback", {
        scope: "local",
        trigger: "refusal",
        direction: "retry",
        original_model: "claude-original",
        fallback_model: "claude-fallback",
        request_id: "local-refusal",
        retracted_message_uuids: ["parent-partial"],
        refused_user_message_uuid: null,
        content: "Worker fallback only.",
      }),
      assistantMessage({
        uuid: "parent-completed",
        apiMessageId: "parent-api",
        content: [{ type: "text", text: "Parent answer" }],
      }),
      claudeSuccessResult("Parent answer", "completed"),
    ]);

    expect(result).toMatchObject({
      status: "completed",
      text: "Parent answer",
    });
    expect(events.flatMap((event) =>
      event.type === "text" ? [event.text] : [])).toEqual([
      "Parent ",
      "answer",
    ]);
    expect(events.some((event) => event.type === "text-snapshot")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      phase: "info",
      label: "A Claude worker used a fallback model",
    }));
  });

  it("prefers pending typed assistant failure over a generic error result", async () => {
    const { result } = await run([
      assistantMessage({
        uuid: "assistant-result-rate-limit",
        apiMessageId: "api-result-rate-limit",
        content: [],
        error: "rate_limit",
      }),
      claudeSystem("model_refusal_fallback", {
        scope: "local",
        trigger: "refusal",
        direction: "retry",
        original_model: "claude-original",
        fallback_model: "claude-worker-fallback",
        request_id: "local-error-refusal",
        retracted_message_uuids: ["assistant-result-rate-limit"],
        refused_user_message_uuid: null,
        content: "Worker retry only.",
      }),
      sdkMessage({
        type: "result",
        subtype: "error_during_execution",
        uuid: "result-generic-error",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: true,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        errors: ["Transport detail at /home/etomas/private.log"],
      }),
    ]);

    expect(result).toMatchObject({
      status: "failed",
      error: "Claude reached an account rate limit.",
      failure: {
        message: "Claude reached an account rate limit.",
        terminalEvent: "assistant/rate_limit",
        activityId: "assistant-result-rate-limit",
        technicalDetail: expect.stringContaining("Transport detail"),
      },
    });
    expect(result.failure?.technicalDetail).not.toContain("/home/etomas");
  });

  it("surfaces authentication guidance and fallback explanations", async () => {
    const { events, result } = await run([
      sdkMessage({
        type: "auth_status",
        isAuthenticating: true,
        output: ["Open the provider URL", "Enter code ABCD"],
        uuid: "auth-started",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
      }),
      sdkMessage({
        type: "auth_status",
        isAuthenticating: false,
        output: ["Authentication complete"],
        uuid: "auth-complete",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
      }),
      claudeSystem("model_refusal_fallback", {
        trigger: "refusal",
        direction: "retry",
        original_model: "claude-original",
        fallback_model: "claude-fallback",
        request_id: "request-refusal",
        api_refusal_category: "policy",
        api_refusal_explanation: "The original response could not continue.",
        retracted_message_uuids: [],
        refused_user_message_uuid: null,
        content: "Retrying with the configured fallback.",
      }),
      claudeSuccessResult("Fallback answer", "completed"),
    ]);
    const activities = events.flatMap((event) =>
      event.type === "activity" ? [event] : []);

    expect(result).toMatchObject({ status: "completed", text: "Fallback answer" });
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Claude is authenticating",
        detail: "Open the provider URL\nEnter code ABCD",
      }),
      expect.objectContaining({
        label: "Claude authenticated",
        detail: "Authentication complete",
      }),
      expect.objectContaining({
        label: "Claude switched to a fallback model",
        detail: expect.stringContaining("The original response could not continue."),
      }),
    ]));
  });

  it("uses the post-reset result as the authoritative conversation text", async () => {
    const { events, result } = await run([
      assistantMessage({
        uuid: "before-reset",
        apiMessageId: "api-before-reset",
        content: [{ type: "text", text: "Old conversation" }],
      }),
      sdkMessage({
        type: "conversation_reset",
        new_conversation_id: "new-conversation",
        uuid: "conversation-reset",
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
      }),
      assistantMessage({
        uuid: "after-reset",
        apiMessageId: "api-after-reset",
        content: [{ type: "text", text: "New conversation" }],
      }),
      claudeSuccessResult("New conversation", "completed"),
    ]);

    expect(result).toMatchObject({
      status: "completed",
      text: "New conversation",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "text-snapshot",
      text: "",
    }));
  });

  it("bounds unfinished stream correlation without taxing sequential streams", () => {
    const sequential = unitProjector();
    expect(() => {
      for (
        let index = 0;
        index < MAX_CLAUDE_STREAM_CORRELATION_BLOCKS * 2;
        index += 1
      ) {
        const apiMessageId = `sequential-api-${index}`;
        sequential.observe(streamMessage(`sequential-start-${index}`, {
          type: "message_start",
          message: { id: apiMessageId },
        }), false);
        sequential.observe(streamMessage(`sequential-delta-${index}`, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "x" },
        }), false);
        sequential.observe(assistantMessage({
          uuid: `sequential-assistant-${index}`,
          apiMessageId,
          content: [{ type: "thinking", thinking: "x" }],
        }), false);
      }
    }).not.toThrow();

    const unfinishedBlocks = unitProjector();
    unfinishedBlocks.observe(streamMessage("unfinished-start", {
      type: "message_start",
      message: { id: "unfinished-api" },
    }), false);
    for (
      let index = 0;
      index < MAX_CLAUDE_STREAM_CORRELATION_BLOCKS;
      index += 1
    ) {
      unfinishedBlocks.observe(streamMessage(`unfinished-${index}`, {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: "x" },
      }), false);
    }
    expect(() => unfinishedBlocks.observe(streamMessage("unfinished-overflow", {
      type: "content_block_delta",
      index: MAX_CLAUDE_STREAM_CORRELATION_BLOCKS,
      delta: { type: "thinking_delta", thinking: "x" },
    }), false)).toThrow(
      "Claude exceeded the bounded stream-correlation state for this run.",
    );

    const unfinishedChars = unitProjector();
    unfinishedChars.observe(streamMessage("unfinished-char-start", {
      type: "message_start",
      message: { id: "unfinished-char-api" },
    }), false);
    const chunk = "x".repeat(MAX_CLAUDE_STREAM_CORRELATION_CHARS / 4);
    for (let index = 0; index < 4; index += 1) {
      unfinishedChars.observe(streamMessage(`unfinished-char-${index}`, {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: chunk },
      }), false);
    }
    expect(() => unfinishedChars.observe(streamMessage(
      "unfinished-char-overflow",
      {
        type: "content_block_delta",
        index: 4,
        delta: { type: "thinking_delta", thinking: "x" },
      },
    ), false)).toThrow(
      "Claude exceeded the bounded stream-correlation state for this run.",
    );
  });

  it("ignores invalid block indices and reconciles non-prefix corrections", () => {
    const indexed = unitProjector();
    indexed.observe(streamMessage("indexed-start", {
      type: "message_start",
      message: { id: "indexed-api" },
    }), false);
    indexed.observe(streamMessage("indexed-invalid", {
      type: "content_block_delta",
      index: 10_001,
      delta: { type: "text_delta", text: "invalid" },
    }), false);
    indexed.observe(streamMessage("indexed-valid", {
      type: "content_block_delta",
      index: 10_000,
      delta: { type: "text_delta", text: "valid" },
    }), false);
    const sparseContent = Array.from<unknown>({ length: 10_001 });
    sparseContent[10_000] = { type: "text", text: "valid" };
    indexed.observe(assistantMessage({
      uuid: "indexed-assistant",
      apiMessageId: "indexed-api",
      content: sparseContent,
    }), false);
    expect(indexed.hadSupersession).toBe(false);

    const corrected = unitProjector();
    corrected.observe(streamMessage("corrected-start", {
      type: "message_start",
      message: { id: "corrected-api" },
    }), false);
    corrected.observe(streamMessage("corrected-delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "stale" },
    }), false);
    corrected.observe(assistantMessage({
      uuid: "corrected-assistant",
      apiMessageId: "corrected-api",
      content: [{ type: "text", text: "authoritative" }],
    }), false);
    expect(corrected.hadSupersession).toBe(true);
  });

  it("does not mark parent supersession for a local worker fallback", () => {
    const projector = unitProjector();
    projector.observe(claudeSystem("model_refusal_fallback", {
      scope: "local",
      trigger: "refusal",
      direction: "retry",
      original_model: "claude-original",
      fallback_model: "claude-worker-fallback",
      request_id: "local-projector-refusal",
      retracted_message_uuids: ["parent-message"],
      refused_user_message_uuid: null,
      content: "Worker fallback only.",
    }), false);

    expect(projector.hadSupersession).toBe(false);
  });

  it("retains text aliases after bounded stream-state eviction", () => {
    const events: AgentHarnessEvent[] = [];
    const projector = unitProjector(events);
    projector.observe(streamMessage("evicted-partial", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "STALE" },
    }), false);
    for (let index = 0; index < 300; index += 1) {
      projector.observe(streamMessage(`eviction-${index}`, {
        type: "message_start",
        message: { id: `eviction-api-${index}` },
      }), false);
    }
    projector.observe(assistantMessage({
      uuid: "after-eviction",
      apiMessageId: "after-eviction-api",
      supersedes: ["evicted-partial"],
      content: [{ type: "text", text: "Replacement" }],
    }), false);

    expect(events).toContainEqual(expect.objectContaining({
      type: "text-snapshot",
      text: "Replacement",
    }));
    expect(projector.authoritativeText()).toBe("Replacement");
  });
});
