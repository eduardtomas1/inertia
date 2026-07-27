import { describe, expect, it } from "vitest";

import {
  contextUsageQualityForTurn,
  contextUsageDisplayValue,
  RECOMMENDED_USAGE_DISPLAY_MODE,
  resolveUsageDisplayPreference,
  usageDisplayBehavior,
} from "../../src/renderer/src/utils/usageDisplay";

describe("usage display behavior", () => {
  it("formalizes hidden, compact, and expanded without a permanent strip", () => {
    expect(usageDisplayBehavior("hidden")).toEqual({
      mode: "hidden",
      surface: "hidden",
      showCircle: false,
      showAdjacentValue: false,
      showPermanentStrip: false,
    });
    expect(usageDisplayBehavior("compact")).toEqual({
      mode: "compact",
      surface: "circle",
      showCircle: true,
      showAdjacentValue: false,
      showPermanentStrip: false,
    });
    expect(usageDisplayBehavior("expanded")).toEqual({
      mode: "expanded",
      surface: "circle-with-value",
      showCircle: true,
      showAdjacentValue: true,
      showPermanentStrip: false,
    });
    expect(RECOMMENDED_USAGE_DISPLAY_MODE).toBe("compact");
  });

  it("preserves every v0.0.8 preference while supporting its legacy boolean", () => {
    expect(resolveUsageDisplayPreference({ usageDisplayMode: "hidden", showUsage: true })).toBe("hidden");
    expect(resolveUsageDisplayPreference({ usageDisplayMode: "compact", showUsage: false })).toBe("compact");
    expect(resolveUsageDisplayPreference({ usageDisplayMode: "expanded", showUsage: false })).toBe("expanded");
    expect(resolveUsageDisplayPreference({ showUsage: false })).toBe("hidden");
    expect(resolveUsageDisplayPreference({ showUsage: true })).toBe("expanded");
  });

  it("uses compact only for new, missing, or malformed preferences", () => {
    expect(resolveUsageDisplayPreference({})).toBe("compact");
    expect(resolveUsageDisplayPreference({ usageDisplayMode: null })).toBe("compact");
    expect(resolveUsageDisplayPreference({ usageDisplayMode: "strip" })).toBe("compact");
    expect(resolveUsageDisplayPreference({ usageDisplayMode: "expanded " })).toBe("compact");
  });
});

describe("context usage display value", () => {
  it("marks a persisted prior-turn value stale until the resumed turn reports usage", () => {
    expect(contextUsageQualityForTurn(null, "turn-2")).toBe("unavailable");
    expect(contextUsageQualityForTurn({ turnId: "turn-1" }, "turn-2")).toBe("stale");
    expect(contextUsageQualityForTurn({ turnId: "turn-2" }, "turn-2")).toBe("current");
    expect(contextUsageQualityForTurn({ turnId: "turn-2" }, null)).toBe("current");
  });

  it("derives the circle value only from valid context occupancy", () => {
    expect(contextUsageDisplayValue({ usedTokens: 25_000, maxTokens: 100_000 }, "current")).toEqual({
      quality: "current",
      remainingPercent: 75,
      valueLabel: "75%",
      accessibleLabel: "Context 75% remaining",
    });
    expect(contextUsageDisplayValue({ usedTokens: 100_000, maxTokens: 100_000 }, "current"))
      .toMatchObject({ remainingPercent: 0, valueLabel: "0%" });
  });

  it("keeps a valid stale context value explicitly stale", () => {
    expect(contextUsageDisplayValue({ usedTokens: 40, maxTokens: 100 }, "stale")).toEqual({
      quality: "stale",
      remainingPercent: 60,
      valueLabel: "60% · stale",
      accessibleLabel: "Context 60% remaining, stale",
    });
  });

  it("never fabricates a percentage for missing, invalid, or explicitly unavailable context", () => {
    const unavailable = {
      quality: "unavailable",
      remainingPercent: null,
      valueLabel: "Unavailable",
      accessibleLabel: "Context usage unavailable",
    } as const;

    expect(contextUsageDisplayValue(null, "unavailable")).toEqual(unavailable);
    expect(contextUsageDisplayValue({ usedTokens: null, maxTokens: 200_000 }, "current")).toEqual(unavailable);
    expect(contextUsageDisplayValue({ usedTokens: 1, maxTokens: null }, "current")).toEqual(unavailable);
    expect(contextUsageDisplayValue({ usedTokens: -1, maxTokens: 200_000 }, "current")).toEqual(unavailable);
    expect(contextUsageDisplayValue({ usedTokens: 200_001, maxTokens: 200_000 }, "current")).toEqual(unavailable);
    expect(contextUsageDisplayValue({ usedTokens: 1, maxTokens: 0 }, "current")).toEqual(unavailable);
    expect(contextUsageDisplayValue({ usedTokens: 50, maxTokens: 100 }, "unavailable")).toEqual(unavailable);
  });

  it("does not accept processed totals or backend quota as a context substitute", () => {
    const nonContextUsage = {
      usedTokens: null,
      maxTokens: null,
      totalProcessedTokens: 900_000,
      remainingPercent: 88,
    };

    expect(contextUsageDisplayValue(nonContextUsage, "current")).toMatchObject({
      quality: "unavailable",
      remainingPercent: null,
    });
  });
});
