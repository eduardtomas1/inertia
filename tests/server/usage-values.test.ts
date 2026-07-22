import { describe, expect, it } from "vitest";

import { parseCodexRateLimits } from "../../src/server/codex-metadata";
import { parseClaudeRateLimits } from "../../src/server/provider/claude-agent-sdk-harness";
import { providerTimestamp } from "../../src/server/provider/usage-values";

describe("provider usage values", () => {
  it("normalizes provider timestamps in seconds, milliseconds, and ISO form", () => {
    expect(providerTimestamp(1_893_456_000)).toBe("2030-01-01T00:00:00.000Z");
    expect(providerTimestamp(1_893_456_000_000)).toBe("2030-01-01T00:00:00.000Z");
    expect(providerTimestamp("2030-01-01T00:00:00-05:00")).toBe("2030-01-01T05:00:00.000Z");
    expect(providerTimestamp("not-a-date")).toBeNull();
    expect(providerTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("preserves finite raw Codex percentages while rejecting malformed windows", () => {
    expect(parseCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 130, windowDurationMins: 300, resetsAt: 1_893_456_000 },
        secondary: { usedPercent: Number.NaN, resetsAt: 1_893_456_000_000 },
      },
    })).toEqual([expect.objectContaining({ usedPercent: 130, remainingPercent: -30, resetsAt: "2030-01-01T00:00:00.000Z" })]);
  });

  it("preserves finite raw Claude utilization and safely parses ISO resets", () => {
    expect(parseClaudeRateLimits({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: -5, resets_at: "2030-01-01T01:00:00+01:00" },
        seven_day: { utilization: Number.POSITIVE_INFINITY, resets_at: "bad" },
      },
    })).toEqual([expect.objectContaining({ usedPercent: -5, remainingPercent: 105, resetsAt: "2030-01-01T00:00:00.000Z" })]);
  });
});
