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
});
