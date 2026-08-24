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
