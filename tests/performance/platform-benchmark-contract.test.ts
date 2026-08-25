import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const benchmarkSource = readFileSync(
  new URL("./platform.benchmark.test.ts", import.meta.url),
  "utf8",
);

describe("platform benchmark threshold ownership", () => {
  it("owns the selected visible-gap ceiling in the hosted enforcement block", () => {
    const enforceIndex = benchmarkSource.indexOf("if (enforce) {");
    const ceilings = [...benchmarkSource.matchAll(
      /expect\(selectedStreamingCadence!\.p95VisibleGapMs\)\s*\.toBeLessThan\(([^)]+)\)/gu,
    )];

    expect(enforceIndex).toBeGreaterThan(-1);
    expect(ceilings).toHaveLength(1);
    expect(ceilings[0]?.[1]).toBe("HOSTED_SELECTED_STREAM_VISIBLE_GAP_MS");
    expect(ceilings[0]?.index).toBeGreaterThan(enforceIndex);
  });

  it("enforces the selected first-projection ceiling on three real samples", () => {
    const enforceIndex = benchmarkSource.indexOf("if (enforce) {");
    const ceilings = [...benchmarkSource.matchAll(
      /expect\(selectedStreamingCadence!\.firstProjectionMs\)\s*\.toBeLessThan\(([^)]+)\)/gu,
    )];
    const rawSampleGuardIndex = benchmarkSource.indexOf(
      "for (const sample of candidate.firstProjectionSamplesMs)",
    );
    const rawSampleCeilingIndex = benchmarkSource.indexOf(
      ".toBeLessThan(HOSTED_STREAM_FIRST_PROJECTION_CATASTROPHIC_MS)",
      rawSampleGuardIndex,
    );

    expect(enforceIndex).toBeGreaterThan(-1);
    expect(benchmarkSource).toContain("const FIRST_PROJECTION_SAMPLE_COUNT = 3;");
    expect(benchmarkSource).toContain(
      "percentile(firstProjectionSamplesMs, 0.5)",
    );
    expect(rawSampleGuardIndex).toBeGreaterThan(enforceIndex);
    expect(rawSampleCeilingIndex).toBeGreaterThan(rawSampleGuardIndex);
    expect(ceilings).toHaveLength(1);
    expect(ceilings[0]?.[1]).toBe("HOSTED_SELECTED_STREAM_FIRST_PROJECTION_MS");
    expect(ceilings[0]?.index).toBeGreaterThan(enforceIndex);
  });
});
