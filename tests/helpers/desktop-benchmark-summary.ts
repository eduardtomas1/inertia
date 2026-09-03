export interface DistributionSummary {
  sampleCount: number;
  minimum: number | null;
  median: number | null;
  p95: number | null;
  maximum: number | null;
}

interface StreamingBenchmarkEvidenceSample {
  p95VisibleGapMs: number;
  longTaskTotalMs: number;
}

export function distribution(values: readonly number[]): DistributionSummary {
  const ordered = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  const percentile = (fraction: number): number | null => ordered.length > 0
    ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))]!
    : null;
  return {
    sampleCount: ordered.length,
    minimum: ordered[0] ?? null,
    median: percentile(0.5),
    p95: percentile(0.95),
    maximum: ordered.at(-1) ?? null,
  };
}

export function summarizeVisibleStreamingCadence(
  observedVisibleGaps: readonly number[],
  acknowledgedPaintIntervalCount: number,
): {
  readonly medianVisibleGapMs: number;
  readonly p95VisibleGapMs: number;
  readonly visibleUpdatesPerSecond: number;
} {
  if (
    !Number.isInteger(acknowledgedPaintIntervalCount)
    || acknowledgedPaintIntervalCount < 0
  ) {
    throw new Error("Acknowledged streaming paint counts must be non-negative integers.");
  }
  if (observedVisibleGaps.some((gap) => !Number.isFinite(gap) || gap <= 0)) {
    throw new Error("Visible streaming gaps must be finite positive durations.");
  }
  if (observedVisibleGaps.length <= acknowledgedPaintIntervalCount) {
    throw new Error("The streaming sample retained no ungated visible cadence.");
  }
  // Every acknowledged paint releases the fixture gate that admits the next
  // payload. Those first intervals measure Playwright/fixture coordination,
  // not production streaming cadence. Keep every later visible interval.
  const measuredVisibleGaps = observedVisibleGaps
    .slice(acknowledgedPaintIntervalCount);
  const visibleGap = distribution(measuredVisibleGaps);
  const visibleDurationMs = measuredVisibleGaps.reduce(
    (sum, gap) => sum + gap,
    0,
  );
  return {
    medianVisibleGapMs:
      visibleGap.median ?? Number.POSITIVE_INFINITY,
    p95VisibleGapMs: visibleGap.p95 ?? Number.POSITIVE_INFINITY,
    visibleUpdatesPerSecond: measuredVisibleGaps.length === 0
      ? 0
      : measuredVisibleGaps.length / (visibleDurationMs / 1_000),
  };
}

export function summarizeStreamingBenchmarkEvidence(
  samples: readonly StreamingBenchmarkEvidenceSample[],
) {
  const visibleGap = distribution(samples.map(({ p95VisibleGapMs }) => p95VisibleGapMs));
  const longTaskTotal = distribution(samples.map(({ longTaskTotalMs }) => longTaskTotalMs));
  return {
    distributions: {
      p95VisibleGapMs: visibleGap,
      longTaskTotalMs: longTaskTotal,
    },
    p95VisibleGapMs: visibleGap.median ?? Number.POSITIVE_INFINITY,
    longTaskTotalMs: longTaskTotal.maximum ?? Number.POSITIVE_INFINITY,
  };
}
