import { describe, expect, it } from "vitest";

import type { EnvironmentUsageSummary } from "../../src/renderer/src/utils/environmentSummary";
import {
  HEADER_METER_LOW_REMAINING_PERCENT,
  headerUsageMeterModel,
  isQuotaResetDue,
  quotaResetLabel,
  quotaWindowLabel,
} from "../../src/renderer/src/utils/headerUsageMeter";

function usage(
  limits: EnvironmentUsageSummary["quota"]["limits"],
  overrides: Partial<EnvironmentUsageSummary["quota"]> = {},
): EnvironmentUsageSummary {
  return {
    providerId: "claude",
    providerLabel: "Claude",
    context: {
      quality: "current",
      remainingPercent: 74,
      valueLabel: "74%",
      accessibleLabel: "74% of context left",
      updatedAt: null,
    },
    quota: {
      freshness: "current",
      source: "selected-route",
      updatedAt: null,
      limits,
      ...overrides,
    },
  };
}

const fiveHour = {
  id: "five-hour",
  label: "Session",
  remainingPercent: 62,
  windowMinutes: 300,
  resetsAt: "2026-09-21T14:20:00.000Z",
};
const weekly = {
  id: "weekly",
  label: "Weekly",
  remainingPercent: 81,
  windowMinutes: 10_080,
  resetsAt: "2026-09-25T09:00:00.000Z",
};

const NOW = Date.parse("2026-09-21T12:00:00.000Z");

describe("header usage meter", () => {
  it("puts the shortest window on top, the longest below, and shows the tightest", () => {
    const model = headerUsageMeterModel(usage([weekly, fiveHour]), NOW);
    expect(model?.primary.id).toBe("five-hour");
    expect(model?.secondary?.id).toBe("weekly");
    expect(model?.tightest.id).toBe("five-hour");
    expect(model?.valueLabel).toBe("62%");
    expect(model?.accessibleLabel).toBe("Usage: 62% of 5-hour limit left");
    expect(model?.low).toBe(false);
  });

  it("turns amber under the 20% threshold on whichever limit is tighter", () => {
    expect(HEADER_METER_LOW_REMAINING_PERCENT).toBe(20);
    const low = headerUsageMeterModel(usage([fiveHour, { ...weekly, remainingPercent: 14 }]), NOW);
    expect(low?.low).toBe(true);
    expect(low?.tightest.id).toBe("weekly");
    expect(low?.accessibleLabel).toBe("Usage: 14% of weekly limit left");
    expect(headerUsageMeterModel(usage([{ ...fiveHour, remainingPercent: 20 }]), NOW)?.low).toBe(false);
    expect(headerUsageMeterModel(usage([{ ...fiveHour, remainingPercent: 19.6 }]), NOW)).toMatchObject({
      low: true,
      valueLabel: "20%",
    });
  });

  it("shows a single bar when only one window is reported", () => {
    const model = headerUsageMeterModel(usage([fiveHour]), NOW);
    expect(model?.secondary).toBeNull();
  });

  it("qualifies stale or refreshing quota in the accessible label", () => {
    expect(headerUsageMeterModel(usage([fiveHour], { freshness: "stale" }), NOW)?.accessibleLabel)
      .toBe("Usage: 62% of 5-hour limit left, may be out of date");
    expect(headerUsageMeterModel(usage([fiveHour], { freshness: "refreshing" }), NOW)?.accessibleLabel)
      .toBe("Usage: 62% of 5-hour limit left, refreshing");
  });

  it("hides without shared quota or limits", () => {
    expect(headerUsageMeterModel(null)).toBeNull();
    expect(headerUsageMeterModel(usage([]), NOW)).toBeNull();
    expect(headerUsageMeterModel(usage([fiveHour], { source: "isolated" }), NOW)).toBeNull();
  });

  it("labels windows and resets", () => {
    expect(quotaWindowLabel(300)).toBe("5-hour");
    expect(quotaWindowLabel(10_080)).toBe("weekly");
    expect(quotaWindowLabel(1_440)).toBe("daily");
    expect(quotaWindowLabel(2_880)).toBe("2-day");
    expect(quotaWindowLabel(45)).toBe("45-minute");
    expect(quotaWindowLabel(null)).toBeNull();
    const now = Date.parse("2026-09-21T12:00:00.000Z");
    expect(quotaResetLabel("2026-09-21T14:20:00.000Z", now)).toBe("Resets in 2h 20m");
    expect(quotaResetLabel("2026-09-21T12:30:00.000Z", now)).toBe("Resets in 30m");
    expect(quotaResetLabel("2026-09-25T09:00:00.000Z", now)).toBe("Resets in 3d 21h");
    expect(quotaResetLabel("2026-09-21T11:00:00.000Z", now)).toBe("Reset due · updating");
    expect(quotaResetLabel(null, now)).toBe("Reset time unavailable");
  });

  it("stops trusting a window once its reset has passed", () => {
    const passed = { ...fiveHour, remainingPercent: 12, resetsAt: "2026-09-21T11:59:00.000Z" };
    expect(isQuotaResetDue(passed, NOW)).toBe(true);
    expect(isQuotaResetDue(fiveHour, NOW)).toBe(false);
    expect(isQuotaResetDue({ resetsAt: null }, NOW)).toBe(false);
    expect(headerUsageMeterModel(usage([passed, weekly]), NOW)).toMatchObject({
      tightest: { id: "weekly" },
      low: false,
      valueLabel: "81%",
    });
    expect(headerUsageMeterModel(usage([passed]), NOW)).toMatchObject({
      low: false,
      valueLabel: "—",
      accessibleLabel: "Usage: reset due, updating",
    });
  });
});
