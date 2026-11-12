import { describe, expect, it } from "vitest";

import {
  summarizePrefetchedSurfaceSamples,
  summarizeStreamingBenchmarkEvidence,
  summarizeVisibleStreamingCadence,
} from "./desktop-benchmark-summary";

const CI_STREAM_VISIBLE_GAP_CATASTROPHIC_MS = 500;
const CI_PREFETCHED_SURFACE_TARGET_MS = 100;

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

describe("desktop benchmark prefetched-surface first opens", () => {
  const warmUp = {
    prefetchedWithinIdleWindow: true,
    commandPaletteFirstOpenMs: 21.4,
    commandPaletteOpenedInInputTask: true,
    settingsFirstOpenMs: 162.5,
    settingsOpenedInInputTask: true,
  };

  function surfaceSamples(
    settings: readonly number[],
    laterTask: { commandPalette?: number; settings?: number } = {},
  ) {
    return settings.map((settingsFirstOpenMs, index) => ({
      prefetchedWithinIdleWindow: index !== 1,
      commandPaletteFirstOpenMs: [10.6, 13.3, 10.8, 12.1, 9.4][index]!,
      commandPaletteOpenedInInputTask: laterTask.commandPalette !== index,
      settingsFirstOpenMs,
      settingsOpenedInInputTask: laterTask.settings !== index,
    }));
  }

  it("gates the fastest measured relaunch and keeps the warm-up and every sample", () => {
    const samples = surfaceSamples([50.8, 119, 47.3, 98.1, 64.4]);

    const summary = summarizePrefetchedSurfaceSamples(warmUp, samples);

    expect(summary.settingsFirstOpenMs).toBe(47.3);
    expect(summary.settingsFirstOpenMs).toBeLessThan(CI_PREFETCHED_SURFACE_TARGET_MS);
    expect(summary.commandPaletteFirstOpenMs).toBe(9.4);
    expect(summary.settingsOpenedInInputTask).toBe(true);
    expect(summary.commandPaletteOpenedInInputTask).toBe(true);
    expect(summary.relaunchesPrefetchedWithinIdleWindow).toBe(4);
    expect(summary.prefetchedSurfaces.warmUp).toEqual(warmUp);
    expect(summary.prefetchedSurfaces.samples).toEqual(samples);
    expect(summary.prefetchedSurfaces.settingsFirstOpenMs).toEqual({
      sampleCount: 5,
      minimum: 47.3,
      median: 64.4,
      p95: 119,
      maximum: 119,
    });
    expect(summary.prefetchedSurfaces.commandPaletteFirstOpenMs.sampleCount).toBe(5);
  });

  it("passes the timing gate when a busy host slows most relaunches of a surface that still opens in the input task", () => {
    const summary = summarizePrefetchedSurfaceSamples(
      warmUp,
      surfaceSamples([40.7, 100.8, 124.1, 106.1, 62.5]),
    );

    expect(summary.prefetchedSurfaces.settingsFirstOpenMs.median).toBe(100.8);
    expect(summary.settingsFirstOpenMs).toBe(40.7);
    expect(summary.settingsFirstOpenMs).toBeLessThan(CI_PREFETCHED_SURFACE_TARGET_MS);
    expect(summary.settingsOpenedInInputTask).toBe(true);
  });

  it("still fails the timing gate when every measured relaunch is slow", () => {
    const summary = summarizePrefetchedSurfaceSamples(
      warmUp,
      surfaceSamples([131.8, 146.5, 211.7, 191.2, 117.5]),
    );

    expect(summary.settingsFirstOpenMs).toBe(117.5);
    expect(summary.settingsFirstOpenMs).toBeGreaterThan(CI_PREFETCHED_SURFACE_TARGET_MS);
  });

  it("reports a surface that opened in a later task on any one relaunch, however fast it was", () => {
    const settings = summarizePrefetchedSurfaceSamples(
      warmUp,
      surfaceSamples([44, 45, 43, 46, 44], { settings: 3 }),
    );
    expect(settings.settingsOpenedInInputTask).toBe(false);
    expect(settings.commandPaletteOpenedInInputTask).toBe(true);

    const commandPalette = summarizePrefetchedSurfaceSamples(
      warmUp,
      surfaceSamples([44, 45, 43, 46, 44], { commandPalette: 0 }),
    );
    expect(commandPalette.commandPaletteOpenedInInputTask).toBe(false);
    expect(commandPalette.settingsOpenedInInputTask).toBe(true);
  });

  it("requires an odd number of measured relaunches", () => {
    expect(() => summarizePrefetchedSurfaceSamples(warmUp, [])).toThrow(
      "Prefetched-surface first opens need an odd number of measured relaunches.",
    );
    expect(() => summarizePrefetchedSurfaceSamples(warmUp, surfaceSamples([50, 60])))
      .toThrow("Prefetched-surface first opens need an odd number of measured relaunches.");
  });
});
