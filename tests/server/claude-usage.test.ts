import { describe, expect, it } from "vitest";

import {
  parseClaudeRateLimitEvent,
  parseClaudeUsage,
} from "../../src/server/provider/claude-usage";

describe("Claude Agent SDK usage accounting", () => {
  it("separates aggregate run processing from the last active iteration", () => {
    expect(parseClaudeUsage({
      num_turns: 3,
      usage: {
        input_tokens: 120_000,
        cache_read_input_tokens: 60_000,
        cache_creation_input_tokens: 10_000,
        output_tokens: 8_000,
        output_tokens_details: { thinking_tokens: 3_200 },
        iterations: [
          {
            type: "message",
            model: "claude-sonnet-test",
            input_tokens: 30_000,
            cache_read_input_tokens: 4_000,
            cache_creation_input_tokens: 1_000,
            output_tokens: 2_000,
          },
          {
            type: "message",
            model: "claude-sonnet-test",
            input_tokens: 70_000,
            cache_read_input_tokens: 20_000,
            cache_creation_input_tokens: 5_000,
            output_tokens: 4_000,
          },
        ],
      },
      modelUsage: {
        "claude-sonnet-test": { contextWindow: 200_000 },
      },
    }, { selectedModelId: "claude-sonnet-test" })).toEqual({
      usedTokens: 99_000,
      totalProcessedTokens: 198_000,
      totalProcessedScope: "run",
      maxTokens: 200_000,
      inputTokens: 190_000,
      cachedInputTokens: 60_000,
      cacheWriteInputTokens: 10_000,
      outputTokens: 8_000,
      reasoningOutputTokens: 3_200,
      compactsAutomatically: null,
    });
  });

  it("prefers the Agent SDK context-control snapshot and only reports explicit compaction state", () => {
    expect(parseClaudeUsage({
      num_turns: 2,
      usage: {
        input_tokens: 80,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
        output_tokens: 5,
        iterations: [{
          type: "message",
          input_tokens: 75,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          output_tokens: 5,
        }],
      },
      modelUsage: { sonnet: { contextWindow: 200_000 } },
    }, {
      contextUsage: {
        totalTokens: 72,
        maxTokens: 180_000,
        rawMaxTokens: 200_000,
        isAutoCompactEnabled: false,
      },
    })).toMatchObject({
      usedTokens: 72,
      maxTokens: 180_000,
      compactsAutomatically: false,
    });

    expect(parseClaudeUsage({
      num_turns: 1,
      usage: { input_tokens: 20, output_tokens: 2 },
      modelUsage: { sonnet: { contextWindow: 200_000 } },
    })?.compactsAutomatically).toBeNull();
  });

  it("uses a single-turn aggregate only when the SDK identifies one turn", () => {
    expect(parseClaudeUsage({
      num_turns: 1,
      usage: {
        input_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
        output_tokens: 10,
      },
      modelUsage: { sonnet: { contextWindow: 200_000 } },
    })).toMatchObject({
      usedTokens: 75,
      totalProcessedTokens: 75,
      maxTokens: 200_000,
    });

    expect(parseClaudeUsage({
      num_turns: 2,
      usage: { input_tokens: 50, output_tokens: 10 },
      modelUsage: { sonnet: { contextWindow: 200_000 } },
    })).toMatchObject({
      usedTokens: null,
      totalProcessedTokens: 60,
      maxTokens: 200_000,
    });
  });

  it("keeps ambiguous model windows and missing provider values unknown", () => {
    expect(parseClaudeUsage({
      num_turns: 2,
      usage: { input_tokens: 50, output_tokens: 10 },
      modelUsage: {
        sonnet: { contextWindow: 200_000 },
        opus: { contextWindow: 1_000_000 },
      },
    })).toMatchObject({ usedTokens: null, maxTokens: null });

    expect(parseClaudeUsage({
      num_turns: 2,
      usage: { input_tokens: 50, output_tokens: 10 },
      modelUsage: {
        sonnet: { contextWindow: 200_000 },
        opus: { contextWindow: 1_000_000 },
      },
    }, { selectedModelId: "sonnet" })).toMatchObject({
      usedTokens: null,
      maxTokens: 200_000,
    });

    expect(parseClaudeUsage({})).toBeNull();
  });

  it("resolves each resumed turn against its selected model without carrying the prior window", () => {
    const result = {
      num_turns: 2,
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        iterations: [{
          type: "message",
          input_tokens: 80,
          output_tokens: 20,
        }],
      },
      modelUsage: {
        sonnet: { contextWindow: 200_000 },
        opus: { contextWindow: 1_000_000 },
      },
    };

    expect(parseClaudeUsage(result, { selectedModelId: "sonnet" })).toMatchObject({
      usedTokens: 100,
      maxTokens: 200_000,
    });
    expect(parseClaudeUsage(result, { selectedModelId: "opus" })).toMatchObject({
      usedTokens: 100,
      maxTokens: 1_000_000,
    });
    expect(parseClaudeUsage(result, { selectedModelId: "unknown-alias" })).toMatchObject({
      usedTokens: 100,
      maxTokens: null,
    });
  });

  it("uses custom route configuration as a window, never as fabricated occupancy", () => {
    expect(parseClaudeUsage({}, {
      selectedModelId: "k3",
      contextWindowOverride: 1_048_576,
    })).toEqual({
      usedTokens: null,
      totalProcessedTokens: null,
      totalProcessedScope: null,
      maxTokens: 1_048_576,
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      compactsAutomatically: null,
    });
  });

  it("uses context apiUsage only as a latest breakdown, not a run total", () => {
    expect(parseClaudeUsage({}, {
      contextUsage: {
        totalTokens: 1_000,
        maxTokens: 200_000,
        isAutoCompactEnabled: true,
        apiUsage: {
          input_tokens: 800,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
          output_tokens: 50,
        },
      },
    })).toEqual({
      usedTokens: 1_000,
      totalProcessedTokens: null,
      totalProcessedScope: null,
      maxTokens: 200_000,
      inputTokens: 950,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 50,
      outputTokens: 50,
      reasoningOutputTokens: null,
      compactsAutomatically: true,
    });
  });

  it("normalizes sparse native rate-limit events with reset timing", () => {
    expect(parseClaudeRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 72.5,
        resetsAt: 1_893_456_000,
      },
    })).toEqual({
      id: "claude:five_hour",
      label: "Claude · 5 hour",
      usedPercent: 72.5,
      remainingPercent: 27.5,
      windowMinutes: 300,
      resetsAt: "2030-01-01T00:00:00.000Z",
    });
    expect(parseClaudeRateLimitEvent({
      rate_limit_info: { rateLimitType: "five_hour" },
    })).toBeNull();
  });
});
