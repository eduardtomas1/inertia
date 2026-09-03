import { describe, expect, it } from "vitest";

import {
  summarizeStreamingBenchmarkEvidence,
  summarizeVisibleStreamingCadence,
} from "./desktop-benchmark-summary";

const CI_STREAM_VISIBLE_GAP_CATASTROPHIC_MS = 500;

function samples(visibleGaps: readonly number[]) {
  return visibleGaps.map((p95VisibleGapMs, index) => ({
    p95VisibleGapMs,
    longTaskTotalMs: [120.2, 418.7, 85.1][index]!,
  }));
}

describe("desktop benchmark streaming summary", () => {
  it("excludes acknowledged fixture gates but retains the measured cadence", () => {
    const summary = summarizeVisibleStreamingCadence([
      533.5,
      82.4,
      94,
      110.1,
      64,
      76,
      70,
      63,
    ], 4);

    expect(summary.medianVisibleGapMs).toBe(70);
    expect(summary.p95VisibleGapMs).toBe(76);
    expect(summary.visibleUpdatesPerSecond).toBeCloseTo(4_000 / 273);
  });

  it("keeps ungated visible stalls in the streaming measurement", () => {
    const summary = summarizeVisibleStreamingCadence([40, 45, 200], 0);

    expect(summary.p95VisibleGapMs).toBe(200);
  });

  it("rejects invalid acknowledged-paint counts", () => {
    expect(() => summarizeVisibleStreamingCadence([50], -1)).toThrow(
      "Acknowledged streaming paint counts must be non-negative integers.",
    );
    expect(() => summarizeVisibleStreamingCadence([50], 1)).toThrow(
      "The streaming sample retained no ungated visible cadence.",
    );
    expect(() => summarizeVisibleStreamingCadence([50, Number.NaN], 0))
      .toThrow("Visible streaming gaps must be finite positive durations.");
  });

  it("gates the representative visible gap while retaining worst-case evidence", () => {
    const summary = summarizeStreamingBenchmarkEvidence(samples([
      517.9,
      280.6,
      90.4,
    ]));

    expect(summary.p95VisibleGapMs).toBe(280.6);
    expect(summary.p95VisibleGapMs).toBeLessThan(CI_STREAM_VISIBLE_GAP_CATASTROPHIC_MS);
    expect(summary.distributions.p95VisibleGapMs.p95).toBe(517.9);
    expect(summary.distributions.p95VisibleGapMs.maximum).toBe(517.9);
    expect(summary.longTaskTotalMs).toBe(418.7);
    expect(summary.distributions.longTaskTotalMs.maximum).toBe(418.7);
  });

  it("still fails the visible-gap gate when the representative sample exceeds it", () => {
    const summary = summarizeStreamingBenchmarkEvidence(samples([
      517.9,
      501,
      90.4,
    ]));

    expect(summary.p95VisibleGapMs).toBe(501);
    expect(summary.p95VisibleGapMs).toBeGreaterThan(CI_STREAM_VISIBLE_GAP_CATASTROPHIC_MS);
    expect(summary.distributions.p95VisibleGapMs.maximum).toBe(517.9);
  });
});
