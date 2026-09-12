import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentHarnessRegistry,
  ProviderManager,
  type AgentHarness,
} from "../../src/server/providers";
import {
  CLAUDE_AGENT_SDK_CAPABILITIES,
  claudeSupportsThinkingDisplay,
  createClaudeAgentSdkHarness,
} from "../../src/server/provider/claude-agent-sdk-harness";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import {
  providerRunTerminal,
  type ProviderEvent,
  type ProviderId,
  type ProviderRunInput,
} from "../../src/server/provider/contracts";
import { ProviderInstallationLeaseCoordinator } from "../../src/server/provider/installation-lease";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { waitForImmediateCondition } from "../helpers/claude-harness-fixture";
import {
  portableFixtureRoot,
  removePortableFixture,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

let frameSequence = 0;

function frame(): Record<string, unknown> {
  frameSequence += 1;
  return {
    uuid: `reliability-frame-${frameSequence}`,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    parent_tool_use_id: null,
  };
}

function streamEvent(event: Record<string, unknown>): SDKMessage {
  return { type: "stream_event", ...frame(), event } as unknown as SDKMessage;
}

function assistant(id: string, content: unknown[]): SDKMessage {
  return {
    type: "assistant",
    ...frame(),
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content,
    },
  } as unknown as SDKMessage;
}

function toolResult(toolUseId: string, content: string): SDKMessage {
  return {
    type: "user",
    ...frame(),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  } as unknown as SDKMessage;
}

function rateLimitEvent(): SDKMessage {
  return {
    type: "rate_limit_event",
    ...frame(),
    rate_limit_info: {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 30,
      resetsAt: 1_893_456_000,
    },
  } as unknown as SDKMessage;
}

/**
 * Claude Code 2.1.269 delivers one assistant frame per content block, all
 * sharing the API message id, and sends native rate-limit events mid-turn.
 */
function perBlockTurn(): SDKMessage[] {
  return [
    rateLimitEvent(),
    streamEvent({ type: "message_start", message: { id: "msg_1", content: [] } }),
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Checking the build first." },
    }),
    assistant("msg_1", [{
      type: "thinking",
      thinking: "Checking the build first.",
      signature: "signature",
    }]),
    streamEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Starting now." },
    }),
    assistant("msg_1", [{ type: "text", text: "Starting now." }]),
    streamEvent({
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
    }),
    assistant("msg_1", [{
      type: "tool_use",
      id: "toolu_1",
      name: "Bash",
      input: { command: "echo hi" },
    }]),
    toolResult("toolu_1", "hi"),
    rateLimitEvent(),
    streamEvent({ type: "message_start", message: { id: "msg_2", content: [] } }),
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " Done." },
    }),
    assistant("msg_2", [{ type: "text", text: " Done." }]),
    claudeSuccessResult("Starting now. Done.", "completed"),
  ];
}

type QueryOptions = Record<string, unknown>;

function attestedClaudeManager(
  streams: () => AsyncGenerator<SDKMessage>,
  version = "2.1.269",
) {
  let cleanupConfirmed = true;
  const queryOptions: QueryOptions[] = [];
  const harness = createClaudeAgentSdkHarness({
    createQuery: ({ options }) => {
      queryOptions.push((options ?? {}) as QueryOptions);
      return fixtureClaudeQuery(streams());
    },
  });
  const manager = ProviderManager.createForTests(
    {
      commands: { claude: "/tools/claude", codex: "/tools/codex" },
      installationLeases: new ProviderInstallationLeaseCoordinator(),
      detectProvider: async (providerId: ProviderId) => ({
        provider: { id: providerId, name: providerId, command: providerId },
        available: true,
        version,
        executable: `/tools/${providerId}`,
        installState: "installed" as const,
        authState: "authenticated" as const,
        canRun: true,
        cleanupConfirmed,
      }),
    },
    new AgentHarnessRegistry([harness]),
  );
  return {
    manager,
    queryOptions,
    setDetectionCleanupConfirmed: (value: boolean) => {
      cleanupConfirmed = value;
    },
  };
}

async function* replay(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  yield claudeSystem("init");
  yield* messages;
}

describe("Claude turn reliability", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function claudeInput(
    conversationId: string,
    extra: Partial<ProviderRunInput> = {},
  ): ProviderRunInput {
    const root = portableFixtureRoot(conversationId);
    roots.push(root);
    return nativeProviderRunInput({
      providerId: "claude",
      conversationId,
      cwd: root,
      prompt: "Fix the build",
      interactionMode: "build",
      access: "full",
      ...extra,
    });
  }

  it("keeps per-block Claude Code turns with native rate limits alive and visible", async () => {
    const { manager } = attestedClaudeManager(() => replay(perBlockTurn()));
    await manager.detect("claude");
    const events: ProviderEvent[] = [];
    const result = await manager.run(claudeInput("claude-per-block"), {
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ status: "completed", text: "Starting now. Done." });
    expect(events.filter((event) => event.type === "text").map((event) =>
      event.type === "text" ? event.text : "")).toEqual(["Starting now.", " Done."]);
    expect(events.some((event) =>
      event.type === "metadata" && event.metadata.rateLimits?.[0]?.id === "claude:five_hour"))
      .toBe(true);
    expect(events.some((event) =>
      event.type === "reasoning-summary" && event.text.includes("Checking the build")))
      .toBe(true);
    // Text and thinking block starts are not tool calls.
    expect(events.filter((event) => event.type === "activity"
      && (event.kind === "tool" || event.kind === "command"))
      .map((event) => event.type === "activity" ? event.label : ""))
      .toEqual(["Bash", "Bash"]);
  });

  it("scopes cleanup doubt to the provider and spares runs that were already admitted", async () => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    let starts = 0;
    const controlled = attestedClaudeManager(() => {
      starts += 1;
      if (starts > 1) return replay(perBlockTurn());
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield claudeSystem("init");
        await streamGate;
        yield* perBlockTurn();
      })();
    });
    const { manager } = controlled;
    await manager.detect("claude");
    await manager.detect("codex");
    const codexInput = nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-bystander",
      cwd: "/workspace",
      prompt: "Unrelated work",
      interactionMode: "build",
      access: "supervised",
    });

    const events: ProviderEvent[] = [];
    const running = manager.run(claudeInput("claude-admitted"), {
      onEvent: (event) => events.push(event),
    });
    await waitForImmediateCondition(() => controlled.queryOptions.length === 1);

    // An unrelated Claude probe cannot confirm its process cleanup mid-turn.
    controlled.setDetectionCleanupConfirmed(false);
    await manager.detect("claude");
    releaseStream();

    await expect(running).resolves.toMatchObject({
      status: "completed",
      text: "Starting now. Done.",
    });
    expect(events.some((event) => event.type === "text")).toBe(true);
    expect(manager.providerCapabilityAvailable(codexInput, "text-streaming"))
      .toBe(true);
    // New Claude turns stay fail-closed, with an actionable reason instead of
    // an opaque capability attestation error.
    expect(() => manager.run(claudeInput("claude-paused")))
      .toThrow(/Claude is paused because Inertia could not confirm .* Restart Inertia to continue\./u);
  });

  it("drops unattested advisory metadata instead of failing the turn", async () => {
    const harness: AgentHarness = {
      id: "claude-agent-sdk",
      providerId: "claude",
      capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
      supports: () => true,
      start: (options) => {
        const emitter = createAgentHarnessEmitter(
          "claude",
          options.input.conversationId,
          options.callbacks,
          options.input.runId,
          options.input.turnId,
        );
        emitter.rich({
          type: "metadata",
          metadata: {
            rateLimits: [{
              id: "claude:five_hour",
              label: "Claude · 5 hour",
              usedPercent: 30,
              remainingPercent: 70,
              windowMinutes: 300,
              resetsAt: null,
            }],
          },
          source: "session",
          complete: false,
        });
        emitter.text("Still working.");
        return {
          harnessId: "claude-agent-sdk",
          providerId: "claude",
          cancel: () => undefined,
          extension: {
            kind: "claude-agent-sdk",
            respondToApproval: () => false,
            respondToInput: () => false,
            steer: async () => false,
          },
          result: Promise.resolve({
            ...providerRunTerminal(options.input, "completed"),
            text: "Still working.",
            textTruncated: false,
            exitCode: 0,
            signal: null,
            cleanupConfirmed: true,
          }),
        };
      },
    };
    const manager = ProviderManager.createForTests(
      {
        commands: { claude: "/tools/claude" },
        installationLeases: new ProviderInstallationLeaseCoordinator(),
        detectProvider: async () => ({
          provider: { id: "claude", name: "claude", command: "claude" },
          available: true,
          version: "2.1.269",
          executable: "/tools/claude",
          installState: "installed" as const,
          authState: "authenticated" as const,
          canRun: true,
          cleanupConfirmed: true,
        }),
      },
      new AgentHarnessRegistry([harness]),
    );
    await manager.detect("claude");
    const events: ProviderEvent[] = [];
    await expect(manager.run(claudeInput("claude-unnegotiated-metadata"), {
      onEvent: (event) => events.push(event),
    })).resolves.toMatchObject({ status: "completed" });
    expect(events.map(({ type }) => type)).toContain("text");
    expect(events.map(({ type }) => type)).not.toContain("metadata");
  });

  it("shortens one oversized tool result instead of failing the turn", async () => {
    const { manager } = attestedClaudeManager(() => replay([
      assistant("msg_big", [{
        type: "tool_use",
        id: "toolu_big",
        name: "Bash",
        input: { command: "./gradlew build --info" },
      }]),
      toolResult("toolu_big", "x".repeat(1_500_000)),
      assistant("msg_after", [{ type: "text", text: "Build finished." }]),
      claudeSuccessResult("Build finished.", "completed"),
    ]));
    await manager.detect("claude");
    const events: ProviderEvent[] = [];
    await expect(manager.run(claudeInput("claude-oversized"), {
      onEvent: (event) => events.push(event),
    })).resolves.toMatchObject({ status: "completed", text: "Build finished." });
    const labels = events.flatMap((event) =>
      event.type === "activity" ? [`${event.label}:${event.phase}`] : []);
    expect(labels.filter((label) => label.startsWith("Shortened a large Claude update")))
      .toHaveLength(1);
    expect(labels).toContain("Bash:completed");
  });

  it("pins subagent limits, forwards the spend limit and asks verified Claude Code for thinking summaries", async () => {
    const verified = attestedClaudeManager(() => replay(perBlockTurn()));
    await verified.manager.detect("claude");
    await verified.manager.run(claudeInput("claude-options", { maxBudgetUsd: 2.5 }));
    const options = verified.queryOptions[0]!;
    expect(options.env).toMatchObject({
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "3",
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "20",
    });
    expect(options.maxBudgetUsd).toBe(2.5);
    expect(options.extraArgs).toEqual({ "thinking-display": "summarized" });

    const older = attestedClaudeManager(() => replay(perBlockTurn()), "2.1.200");
    await older.manager.detect("claude");
    await older.manager.run(claudeInput("claude-older-cli"));
    expect(older.queryOptions[0]!.extraArgs).toBeUndefined();
    expect(older.queryOptions[0]!.maxBudgetUsd).toBeUndefined();
  });

  it("recognizes Claude Code versions verified for thinking summaries", () => {
    expect(claudeSupportsThinkingDisplay("2.1.269 (Claude Code)")).toBe(true);
    expect(claudeSupportsThinkingDisplay("2.2.0")).toBe(true);
    expect(claudeSupportsThinkingDisplay("3.0.1")).toBe(true);
    expect(claudeSupportsThinkingDisplay("2.1.268")).toBe(false);
    expect(claudeSupportsThinkingDisplay("2.0.999")).toBe(false);
    expect(claudeSupportsThinkingDisplay("unknown")).toBe(false);
    expect(claudeSupportsThinkingDisplay(null)).toBe(false);
  });

  it("reports a spend-limit stop with the configured-limit message", async () => {
    const { manager } = attestedClaudeManager(() => replay([{
      ...claudeSuccessResult("", "completed"),
      subtype: "error_max_budget_usd",
      is_error: true,
      errors: [],
    } as unknown as SDKMessage]));
    await manager.detect("claude");
    await expect(manager.run(claudeInput("claude-spend-limit", { maxBudgetUsd: 1 })))
      .resolves.toMatchObject({
        status: "failed",
        error: "Claude reached the configured spending limit.",
      });
  });
});
