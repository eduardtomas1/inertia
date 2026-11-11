import { describe, expect, it } from "vitest";

import {
  chartScale,
  costGapLabel,
  costTypeSegments,
  partialEstimateNote,
  priceListAge,
  priceListName,
  pricingNote,
  shareOf,
  sortByMetric,
  sumMeasured,
  tokenTypeSegments,
  usageDashboardCommand,
  visibleUsage,
} from "../../src/renderer/src/components/usage/UsageOverviewModel";
import {
  formatShare,
  formatUsd,
  formatUsdAxis,
} from "../../src/renderer/src/lib/usageFormat";
import { usageDashboardSchema } from "../../src/shared/contracts/usage-dashboard-schema";
import {
  cost,
  emptyDashboard,
  metric,
  unpricedDashboard,
  usageDashboard,
  zero,
} from "./usage-overview-fixture";

describe("usage money formatting", () => {
  it("formats dollars with two grouped decimals", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(13.75)).toBe("$13.75");
    expect(formatUsd(1_234.56)).toBe("$1,234.56");
    expect(formatUsd(1_234_567.891)).toBe("$1,234,567.89");
  });

  it("never rounds a real sub-cent amount down to zero or up to a cent", () => {
    expect(formatUsd(0.000001)).toBe("<$0.01");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.0099)).toBe("<$0.01");
  });

  it("keeps axis ticks short at every magnitude", () => {
    expect(formatUsdAxis(0)).toBe("$0");
    expect(formatUsdAxis(0.002)).toBe("$0.002");
    expect(formatUsdAxis(0.05)).toBe("$0.05");
    expect(formatUsdAxis(0.5)).toBe("$0.50");
    expect(formatUsdAxis(2.5)).toBe("$2.50");
    expect(formatUsdAxis(5)).toBe("$5");
    expect(formatUsdAxis(250)).toBe("$250");
    expect(formatUsdAxis(1_500)).toBe("$1.5K");
  });

  it("formats shares with one decimal and a floor for tiny non-zero shares", () => {
    expect(formatShare(0.909090)).toBe("90.9%");
    expect(formatShare(1)).toBe("100%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.0004)).toBe("<0.1%");
  });
});

describe("usage overview fixtures", () => {
  it("match the dashboard contract the runtime validates", () => {
    for (const days of [7, 30, 90] as const) {
      expect(usageDashboardSchema(usageDashboard(days))).toBe(true);
      expect(usageDashboardSchema(unpricedDashboard(days))).toBe(true);
      expect(usageDashboardSchema(emptyDashboard(days))).toBe(true);
    }
  });
});

describe("usage overview model", () => {
  it("builds the dashboard command for the local calendar range", () => {
    const command = usageDashboardCommand(7, new Date(2026, 5, 30, 15, 30));
    expect(command.type).toBe("usage.dashboard.get");
    expect(command.payload.days).toBe(7);
    expect(command.payload.endDate).toBe("2026-06-30");
    expect(command.payload.fromInclusive).toBe(new Date(2026, 5, 24).toISOString());
    expect(command.payload.toExclusive).toBe(new Date(2026, 6, 1).toISOString());
    expect(command.payload.timeZone).not.toBe("");
  });

  it("sums measured values and derives coverage from the parts", () => {
    expect(sumMeasured([metric(10, 2, 2), metric(5, 1, 1)])).toEqual(metric(15, 3, 3));
    expect(sumMeasured([metric(10, 2, 2), metric(5, 1, 3)])).toEqual(metric(15, 3, 5));
    expect(sumMeasured([metric(10, 2, 2), metric(null, 0, 3)])).toEqual(metric(10, 2, 5));
    expect(sumMeasured([metric(null, 0, 2), metric(null, 0, 3)])).toEqual(metric(null, 0, 5));
    expect(sumMeasured([])).toEqual(metric(null, 0, 0));
    expect(sumMeasured([], true)).toEqual(zero());
    expect(sumMeasured([cost(0.1, 1, 1), cost(0.2, 1, 1)]).value).toBeCloseTo(0.3, 10);
  });

  it("returns the server totals untouched when no provider with usage is hidden", () => {
    const dashboard = usageDashboard();
    const data = visibleUsage(dashboard, new Set(["kimi", "grok"]));
    expect(data.filtered).toBe(false);
    expect(data.cost).toBe(dashboard.totals.cost);
    expect(data.processedTokens).toBe(dashboard.totals.processedTokens);
    expect(data.daily).toBe(dashboard.daily);
    expect(data.statusCounts).toEqual({ completed: 4, failed: 1, cancelled: 0, interrupted: 1 });
  });

  it("recomputes totals, days and models from the visible providers", () => {
    const data = visibleUsage(usageDashboard(), new Set(["claude"]));
    expect(data.filtered).toBe(true);
    expect(data.hiddenProviderCount).toBe(1);
    expect(data.providers.map(({ providerId }) => providerId)).toEqual(["codex"]);
    expect(data.models.map(({ model }) => model)).toEqual(["gpt-6.1-codex-high"]);
    expect(data.requestCount).toBe(2);
    expect(data.activeDays).toBe(2);
    expect(data.cost).toEqual(cost(1.25, 1, 2));
    expect(data.processedTokens).toEqual(metric(1_000, 1, 2));
    expect(data.runtime).toEqual(metric(5_000, 1, 2));
    expect(data.statusCounts).toBeNull();
    const last = data.daily.at(-1)!;
    expect(last.requestCount).toBe(1);
    expect(last.cost).toEqual(cost(1.25, 1, 1));
    expect(last.providers.map(({ providerId }) => providerId)).toEqual(["codex"]);
    expect(data.daily.at(-4)!.cost).toEqual(cost(null, 0, 1));
    expect(data.daily[0]!.cost).toEqual(zero());
  });

  it("leaves nothing visible when every provider with usage is hidden", () => {
    const data = visibleUsage(usageDashboard(), new Set(["claude", "codex"]));
    expect(data.requestCount).toBe(0);
    expect(data.hiddenProviderCount).toBe(2);
    expect(data.providers).toEqual([]);
    expect(data.cost).toEqual(metric(null, 0, 0));
  });

  it("orders providers by the active metric and puts unpriced models last on cost", () => {
    const dashboard = usageDashboard();
    dashboard.providers[1]!.processedTokens = metric(9_000, 2, 2);
    expect(sortByMetric(dashboard.providers, "cost").map(({ key }) => key)).toEqual(["claude", "codex"]);
    expect(sortByMetric(dashboard.providers, "tokens").map(({ key }) => key)).toEqual(["codex", "claude"]);
    expect(sortByMetric(dashboard.models, "cost").map(({ model }) => model))
      .toEqual(["claude-fable-5", "gpt-6.1-codex-high", "<synthetic>"]);
  });

  it("withholds a share when either side is unmeasured or the total is zero", () => {
    expect(shareOf(cost(1, 1, 1), cost(4, 2, 2))).toBe(0.25);
    expect(shareOf(cost(null, 0, 1), cost(4, 2, 2))).toBeNull();
    expect(shareOf(cost(1, 1, 1), cost(null, 0, 2))).toBeNull();
    expect(shareOf(metric(0, 1, 1), metric(0, 2, 2))).toBeNull();
  });

  it("calls a gap unpriced only when every unestimated model lacks a price", () => {
    const { models } = usageDashboard();
    expect(costGapLabel(models)).toBe("Unpriced");
    expect(costGapLabel([])).toBe("Unpriced");
    expect(costGapLabel(models.map((model) => ({ ...model, cost: cost(null, 0, model.requestCount) }))))
      .toBe("No estimate");
  });

  it("names the price list and its age without calling it a bill", () => {
    const dashboard = usageDashboard();
    expect(pricingNote(dashboard))
      .toBe("Prices: LiteLLM model price list, updated 3 hours ago · 1,912 models.");
    dashboard.cost.pricing = { ...dashboard.cost.pricing, status: "cached", fetchedAt: "2026-06-27T00:00:00.000Z" };
    expect(pricingNote(dashboard))
      .toBe("Prices: LiteLLM model price list, cached copy from 4 days ago · 1,912 models. The latest list could not be downloaded.");
    expect(pricingNote(unpricedDashboard())).toBe("Prices: LiteLLM model price list, unavailable.");
  });

  it("describes price list age and source defensively", () => {
    const generatedAt = "2026-07-01T00:00:00.000Z";
    expect(priceListAge(null, generatedAt)).toBeNull();
    expect(priceListAge("not a date", generatedAt)).toBeNull();
    expect(priceListAge("2026-06-30T23:59:30.000Z", generatedAt)).toBe("just now");
    expect(priceListAge("2026-06-30T23:15:00.000Z", generatedAt)).toBe("45 minutes ago");
    expect(priceListAge("2026-06-30T23:00:00.000Z", generatedAt)).toBe("1 hour ago");
    expect(priceListAge("2026-06-29T18:00:00.000Z", generatedAt)).toBe("30 hours ago");
    expect(priceListAge("2026-06-21T00:00:00.000Z", generatedAt)).toBe("10 days ago");
    expect(priceListAge("2026-07-02T00:00:00.000Z", generatedAt)).toMatch(/Jul 2, 2026/u);
    expect(priceListName("http://127.0.0.1:4010/prices.json")).toBe("price list at 127.0.0.1:4010");
    expect(priceListName("not a url")).toBe("model price list");
  });

  it("explains a partial estimate only when the estimate is partial", () => {
    expect(partialEstimateNote(cost(13.75, 4, 6))).toBe(
      "The estimate covers 4 of 6 requests. The rest used models without a known price or did not report token detail.",
    );
    expect(partialEstimateNote(cost(13.75, 6, 6))).toBeNull();
    expect(partialEstimateNote(cost(null, 0, 6))).toBeNull();
  });
});

describe("usage overview type shares", () => {
  it("splits reported input into disjoint uncached, cache-read and cache-write tokens", () => {
    const dashboard = usageDashboard();
    expect(tokenTypeSegments(dashboard).map(({ label, value }) => [label, value])).toEqual([
      ["Uncached input", 1_780],
      ["Cache read", 900],
      ["Cache write", 120],
      ["Output", 700],
    ]);
    dashboard.tokens.cachedInput = metric(5_000, 3, 6);
    expect(tokenTypeSegments(dashboard).map(({ value }) => value)).toEqual([0, 2_800, 0, 700]);
    dashboard.tokens.input = metric(null, 0, 6);
    expect(tokenTypeSegments(dashboard).map(({ value }) => value)).toEqual([0, 5_000, 120, 700]);
  });

  it("takes cost shares straight from the priced categories", () => {
    expect(costTypeSegments(usageDashboard()).map(({ kind, value }) => [kind, value])).toEqual([
      ["input", 6],
      ["cachedInput", 0.75],
      ["cacheWriteInput", 0.5],
      ["output", 6.5],
    ]);
  });
});

describe("usage overview chart scale", () => {
  it("ends every scale at an exact zero tick for fractional dollar steps", () => {
    for (const peak of [0.003, 0.07, 0.3, 1.25, 12.5, 137, 2_100, 5_000_000]) {
      const { maximum, ticks } = chartScale(peak);
      expect(ticks.at(-1)).toBe(0);
      expect(ticks[0]).toBe(maximum);
      expect(maximum).toBeGreaterThanOrEqual(peak);
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.length).toBeLessThanOrEqual(6);
      expect(new Set(ticks).size).toBe(ticks.length);
    }
    expect(chartScale(12.5).ticks).toEqual([15, 10, 5, 0]);
    expect(chartScale(0.3).ticks).toEqual([0.3, 0.2, 0.1, 0]);
    expect(chartScale(0)).toEqual({ maximum: 1, ticks: [1, 0] });
  });
});
