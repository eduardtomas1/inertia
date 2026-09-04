import { describe, expect, it } from "vitest";

import { dailyWorkDashboardSchema } from "../../src/shared/contracts/daily-work-schema";
import { usageDashboardSchema } from "../../src/shared/contracts/usage-dashboard-schema";

const measured = {
  value: 0,
  measuredRequests: 0,
  totalRequests: 0,
  coverage: "complete",
};

describe("Gemini analytics schemas", () => {
  it("accepts Gemini in the daily-work provider breakdown", () => {
    expect(dailyWorkDashboardSchema({
      generatedAt: "2030-01-01T12:00:00.000Z",
      date: "2030-01-01",
      range: {
        fromInclusive: "2030-01-01T00:00:00.000Z",
        toExclusive: "2030-01-02T00:00:00.000Z",
        timeZone: "UTC",
      },
      totals: {
        conversationCount: 0,
        turnCount: 0,
        activeTurnCount: 0,
        runtime: measured,
        processedTokens: measured,
      },
      providers: [{
        providerId: "gemini",
        providerLabel: "Gemini",
        turnCount: 0,
        activeTurnCount: 0,
        runtime: measured,
        processedTokens: measured,
      }],
      conversations: [],
    })).toBe(true);
  });

  it("accepts Gemini in the usage provider breakdown", () => {
    expect(usageDashboardSchema({
      generatedAt: "2030-01-01T12:00:00.000Z",
      range: {
        days: 7,
        fromInclusive: "2029-12-26T00:00:00.000Z",
        toExclusive: "2030-01-02T00:00:00.000Z",
        startDate: "2029-12-26",
        endDate: "2030-01-01",
        timeZone: "UTC",
      },
      totals: {
        requestCount: 0,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        interruptedCount: 0,
        activeDays: 0,
        runtime: measured,
        processedTokens: measured,
      },
      daily: [
        "2029-12-26",
        "2029-12-27",
        "2029-12-28",
        "2029-12-29",
        "2029-12-30",
        "2029-12-31",
        "2030-01-01",
      ].map((date) => ({
        date,
        requestCount: 0,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        interruptedCount: 0,
        runtime: measured,
        processedTokens: measured,
        providers: [],
      })),
      providers: [{
        key: "gemini",
        providerId: "gemini",
        providerLabel: "Gemini",
        requestCount: 0,
        runtime: measured,
        processedTokens: measured,
      }],
      models: [],
      tokens: {
        input: measured,
        cachedInput: measured,
        cacheWriteInput: measured,
        output: measured,
        reasoningOutput: measured,
      },
      cost: {
        status: "unavailable",
        reason: "No pricing provenance.",
      },
    })).toBe(true);
  });
});
