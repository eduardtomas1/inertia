// @inertia-test-suite portable
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Options as ClaudeOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AgentHarnessEvent, AgentHarnessStartOptions } from "../../src/server/provider/agent-harness";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const FIRST_REQUEST = "2026-10-25T09:00:00.000Z";
const LAST_REQUEST = "2026-10-25T09:00:30.000Z";

function messageStart(uuid: string, usage: Record<string, unknown> | undefined, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: "stream_event",
    uuid,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    parent_tool_use_id: parentToolUseId,
    event: { type: "message_start", message: { id: `api-${uuid}`, ...(usage ? { usage } : {}) } },
  } as unknown as SDKMessage;
}

function cacheUsage(fiveMinute: number, oneHour: number): Record<string, unknown> {
  return {
    input_tokens: 10,
    cache_read_input_tokens: 200_000,
    cache_creation_input_tokens: fiveMinute + oneHour,
    cache_creation: { ephemeral_5m_input_tokens: fiveMinute, ephemeral_1h_input_tokens: oneHour },
    output_tokens: 1,
  };
}

interface Step {
  at?: string;
  message: SDKMessage;
}

describe("Claude prompt cache facts", () => {
  const roots: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T08:59:00.000Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  async function run(
    steps: readonly Step[],
    options: Partial<AgentHarnessStartOptions> = {},
    inputOverrides: Partial<AgentHarnessStartOptions["input"]> = {},
  ): Promise<{
    events: AgentHarnessEvent[];
    queryOptions: ClaudeOptions | undefined;
  }> {
    const root = portableFixtureRoot("Claude prompt cache facts");
    roots.push(root);
    const events: AgentHarnessEvent[] = [];
    let queryOptions: ClaudeOptions | undefined;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options: launched }) => {
        queryOptions = launched;
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSystem("init", { model: "claude-test" });
          for (const step of steps) {
            if (step.at) vi.setSystemTime(new Date(step.at));
            yield step.message;
          }
          yield claudeSuccessResult("Done");
        })());
      },
    });
    const providerRun = harness.start({
      input: {
        ...nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-prompt-cache",
          cwd: root,
          prompt: "Continue",
          interactionMode: "build",
          access: "supervised",
        }),
        ...inputOverrides,
      },
      executable: process.execPath,
      environment: {},
      providerNativeToolsAvailable: true,
      callbacks: { onEvent: (event) => events.push(event) },
      ...options,
    });
    await providerRun.result;
    return { events, queryOptions };
  }

  const promptCache = (events: readonly AgentHarnessEvent[]) => events
    .flatMap((event) => event.type === "extension" && event.event.type === "usage" ? [event.event.usage.promptCache] : []);

  it("reports the one-hour cache from the last main-thread request", async () => {
    const { events } = await run([
      { at: FIRST_REQUEST, message: messageStart("first", cacheUsage(800, 0)) },
      { at: LAST_REQUEST, message: messageStart("last", cacheUsage(0, 1_200)) },
      { at: "2026-10-25T09:00:40.000Z", message: messageStart("child", cacheUsage(50, 0), "toolu_child") },
    ]);
    expect(promptCache(events)).toEqual([{ lastRequestStartedAt: LAST_REQUEST, lifetimeMs: 3_600_000, source: "reported" }]);
  });

  it("reports the five-minute cache when only short cache writes are present", async () => {
    const { events } = await run([
      { at: LAST_REQUEST, message: messageStart("only", cacheUsage(900, 0)) },
    ]);
    expect(promptCache(events)).toEqual([{ lastRequestStartedAt: LAST_REQUEST, lifetimeMs: 300_000, source: "reported" }]);
  });

  it("reports the five-minute cache when a request writes both lifetimes, because its tail is the short part", async () => {
    const { events } = await run([
      { at: LAST_REQUEST, message: messageStart("both", cacheUsage(400, 1_200)) },
    ]);
    expect(promptCache(events)).toEqual([{ lastRequestStartedAt: LAST_REQUEST, lifetimeMs: 300_000, source: "reported" }]);
  });

  it("keeps the reported lifetime when a later request only reads the cache", async () => {
    const { events } = await run([
      { at: FIRST_REQUEST, message: messageStart("write", cacheUsage(0, 700)) },
      { at: LAST_REQUEST, message: messageStart("read", cacheUsage(0, 0)) },
    ]);
    expect(promptCache(events)).toEqual([{ lastRequestStartedAt: LAST_REQUEST, lifetimeMs: 3_600_000, source: "reported" }]);
  });

  it("assumes the five-minute default when Claude reports no cache breakdown", async () => {
    const { events } = await run([
      { at: LAST_REQUEST, message: messageStart("plain", undefined) },
    ]);
    expect(promptCache(events)).toEqual([{ lastRequestStartedAt: LAST_REQUEST, lifetimeMs: 300_000, source: "assumed" }]);
  });

  it("uses the configured one-hour cache when Claude reports no cache breakdown", async () => {
    const { events, queryOptions } = await run([
      { at: LAST_REQUEST, message: messageStart("plain", { input_tokens: 5, output_tokens: 1 }) },
    ], { harnessConfiguration: { kind: "claude-messages", promptCacheTtl: "1h" } });
    expect(promptCache(events)).toEqual([{ lastRequestStartedAt: LAST_REQUEST, lifetimeMs: 3_600_000, source: "configured" }]);
    expect(queryOptions?.settings).toEqual({ promptCacheTtl: "1h" });
  });

  it("leaves earlier facts in place when the run made no main-thread request", async () => {
    const { events, queryOptions } = await run([]);
    expect(promptCache(events)).toEqual([undefined]);
    expect(queryOptions).not.toHaveProperty("settings");
  });

  it("merges the cache length with the fast mode settings", async () => {
    const { queryOptions } = await run([], {
      harnessConfiguration: { kind: "claude-messages", promptCacheTtl: "5m" },
    }, { supportedFastMode: "fast" });
    expect(queryOptions?.settings).toEqual({ fastMode: false, fastModePerSessionOptIn: true, promptCacheTtl: "5m" });
  });
});
