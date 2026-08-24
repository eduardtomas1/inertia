import { describe, expect, it } from "vitest";

import { summarizeStreamingBenchmarkEvidence } from "./desktop-benchmark-summary";

const CI_STREAM_VISIBLE_GAP_CATASTROPHIC_MS = 500;

function samples(visibleGaps: readonly number[]) {
  return visibleGaps.map((p95VisibleGapMs, index) => ({
    p95VisibleGapMs,
    longTaskTotalMs: [120.2, 418.7, 85.1][index]!,
  }));
}

describe("desktop benchmark streaming summary", () => {
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
