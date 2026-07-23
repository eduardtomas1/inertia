import { describe, expect, it } from "vitest";

import { parseCodexRateLimits } from "../../src/server/codex-metadata";
import { parseClaudeRateLimits } from "../../src/server/provider/claude-agent-sdk-harness";
import { providerTimestamp, validateProviderUsage } from "../../src/server/provider/usage-values";

describe("provider usage values", () => {
  it("normalizes provider timestamps in seconds, milliseconds, and ISO form", () => {
    expect(providerTimestamp(1_893_456_000)).toBe("2030-01-01T00:00:00.000Z");
    expect(providerTimestamp(1_893_456_000_000)).toBe("2030-01-01T00:00:00.000Z");
    expect(providerTimestamp("2030-01-01T00:00:00-05:00")).toBe("2030-01-01T05:00:00.000Z");
    expect(providerTimestamp("not-a-date")).toBeNull();
    expect(providerTimestamp("January 1, 2030")).toBeNull();
    expect(providerTimestamp("2030-02-30T00:00:00.000Z")).toBeNull();
    expect(providerTimestamp("2030-01-01T25:00:00.000Z")).toBeNull();
    expect(providerTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("clamps Codex percentages while rejecting malformed windows", () => {
    expect(parseCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 130, windowDurationMins: 300, resetsAt: 1_893_456_000 },
        secondary: { usedPercent: Number.NaN, resetsAt: 1_893_456_000_000 },
      },
    })).toEqual([expect.objectContaining({ usedPercent: 100, remainingPercent: 0, resetsAt: "2030-01-01T00:00:00.000Z" })]);
  });

  it("clamps Claude utilization and safely parses ISO resets", () => {
    expect(parseClaudeRateLimits({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: -5, resets_at: "2030-01-01T01:00:00+01:00" },
        seven_day: { utilization: Number.POSITIVE_INFINITY, resets_at: "bad" },
      },
    })).toEqual([expect.objectContaining({ usedPercent: 0, remainingPercent: 100, resetsAt: "2030-01-01T00:00:00.000Z" })]);
  });

  it("rejects impossible context values before persistence without discarding valid usage", () => {
    expect(validateProviderUsage({
      usedTokens: 220_000,
      totalProcessedTokens: 900,
      totalProcessedScope: "session",
      maxTokens: 200_000,
      inputTokens: -1,
      cachedInputTokens: 12.5,
      cacheWriteInputTokens: Number.POSITIVE_INFINITY,
      outputTokens: 30,
      reasoningOutputTokens: 4,
      compactsAutomatically: "yes",
    })).toEqual({
      usedTokens: null,
      totalProcessedTokens: 900,
      totalProcessedScope: "session",
      maxTokens: 200_000,
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: 30,
      reasoningOutputTokens: 4,
      compactsAutomatically: null,
    });
    expect(validateProviderUsage({
      usedTokens: -1,
      totalProcessedTokens: Number.NaN,
      totalProcessedScope: "thread",
      maxTokens: 0,
    })).toMatchObject({
      usedTokens: null,
      totalProcessedTokens: null,
      totalProcessedScope: null,
      maxTokens: null,
    });
  });
});
