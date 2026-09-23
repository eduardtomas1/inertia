import { describe, expect, it } from "vitest";

import {
  advanceOrbDwell,
  createOrbDwell,
  ORB_CROSSFADE_MS,
  ORB_MIN_DWELL_MS,
  ORB_SETTLE_MS,
  orbCrossfade,
  orbDwellDeadline,
  requestOrbDesign,
} from "../../src/renderer/src/components/working-indicator/orbDwell";
import {
  contrastLiftForSize,
  inkFor,
  orbBleed,
  orbGlowStyle,
  parseCssRgb,
} from "../../src/renderer/src/components/working-indicator/orbPaint";

describe("orb dwell and crossfade", () => {
  it("keeps the first design for the minimum dwell before switching", () => {
    let state = createOrbDwell("connecting", 0);
    expect(ORB_MIN_DWELL_MS).toBeGreaterThanOrEqual(400);
    expect(ORB_MIN_DWELL_MS).toBeLessThanOrEqual(600);
    state = requestOrbDesign(state, "composing", 100);
    expect(orbDwellDeadline(state)).toBe(ORB_MIN_DWELL_MS);
    expect(advanceOrbDwell(state, ORB_MIN_DWELL_MS - 1).shown).toBe("connecting");
    state = advanceOrbDwell(state, ORB_MIN_DWELL_MS);
    expect(state.shown).toBe("composing");
    expect(state.previous).toBe("connecting");
  });

  it("does not strobe when a phase flaps and returns within the settle window", () => {
    let state = createOrbDwell("connecting", 0);
    state = advanceOrbDwell(state, 5_000);
    state = requestOrbDesign(state, "composing", 5_000);
    state = requestOrbDesign(state, "connecting", 5_060);
    expect(orbDwellDeadline(state)).toBeNull();
    for (const now of [5_100, 5_200, 5_600, 6_000]) {
      state = advanceOrbDwell(state, now);
      expect(state.shown).toBe("connecting");
    }
  });

  it("switches after the settle time once the shown design has dwelt long enough", () => {
    let state = createOrbDwell("breathing", 0);
    state = requestOrbDesign(state, "searching", 2_000);
    expect(orbDwellDeadline(state)).toBe(2_000 + ORB_SETTLE_MS);
    expect(advanceOrbDwell(state, 2_000 + ORB_SETTLE_MS - 1).shown).toBe("breathing");
    expect(advanceOrbDwell(state, 2_000 + ORB_SETTLE_MS).shown).toBe("searching");
  });

  it("crossfades for a short time and never under reduced motion", () => {
    let state = createOrbDwell("breathing", 0);
    state = advanceOrbDwell(requestOrbDesign(state, "solving", 1_000), 1_200);
    expect(orbCrossfade(state, 1_200, false)).toEqual({ previous: "breathing", progress: 0 });
    expect(orbCrossfade(state, 1_200 + ORB_CROSSFADE_MS / 2, false)).toEqual({ previous: "breathing", progress: 0.5 });
    expect(orbCrossfade(state, 1_200 + ORB_CROSSFADE_MS, false)).toEqual({ previous: null, progress: 1 });
    expect(orbCrossfade(state, 1_200, true)).toEqual({ previous: null, progress: 1 });
    expect(ORB_CROSSFADE_MS).toBe(160);
  });
});

describe("orb colour ramp", () => {
  it("keeps theme ink grey and mirrors it for dark themes", () => {
    expect(inkFor(0.2, false, null, 0)).toEqual([51, 51, 51]);
    expect(inkFor(0.2, true, null, 0)).toEqual([204, 204, 204]);
    expect(inkFor(-3, true, null, 0)).toEqual([255, 255, 255]);
    expect(inkFor(4, false, null, 0)).toEqual([255, 255, 255]);
  });

  it("lifts contrast for orbs smaller than 24px", () => {
    expect(contrastLiftForSize(18)).toBe(0.35);
    expect(contrastLiftForSize(24)).toBe(0);
    expect(contrastLiftForSize(44)).toBe(0);
    const [darkFar] = inkFor(0.9, true, null, 0);
    const [darkFarLifted] = inkFor(0.9, true, null, 0.35);
    expect(darkFarLifted).toBeGreaterThan(darkFar);
    const [lightNear] = inkFor(0.1, false, null, 0);
    const [lightNearLifted] = inkFor(0.1, false, null, 0.35);
    expect(lightNearLifted).toBeLessThan(lightNear);
  });

  it("shades a colour from darker far dots to brighter near dots", () => {
    const lilac = [199, 125, 255] as const;
    const far = inkFor(0.78, true, lilac, 0);
    const near = inkFor(0.05, true, lilac, 0);
    expect(near[0] + near[1] + near[2]).toBeGreaterThan(far[0] + far[1] + far[2]);
    const lightNear = inkFor(0.05, false, lilac, 0);
    const lightFar = inkFor(0.78, false, lilac, 0);
    expect(lightNear[0] + lightNear[1] + lightNear[2]).toBeLessThan(lightFar[0] + lightFar[1] + lightFar[2]);
    for (const channel of [...near, ...far, ...lightNear, ...lightFar]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });

  it("parses CSS colours defensively", () => {
    expect(parseCssRgb("#c77dff")).toEqual([199, 125, 255]);
    expect(parseCssRgb("#FFF")).toEqual([255, 255, 255]);
    expect(parseCssRgb("rgb(163, 163, 250)")).toEqual([163, 163, 250]);
    expect(parseCssRgb("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
    for (const invalid of ["", null, undefined, "tomato", "rgb(300, 0, 0)", "#12345"]) {
      expect(parseCssRgb(invalid)).toBeNull();
    }
  });

  it("tunes a softer, tighter halo for small orbs and light themes", () => {
    const lilac = [199, 125, 255] as const;
    const darkLarge = orbGlowStyle(lilac, true, 44);
    const darkSmall = orbGlowStyle(lilac, true, 14);
    const lightLarge = orbGlowStyle(lilac, false, 44);
    expect(darkSmall.alpha).toBeLessThan(darkLarge.alpha);
    expect(darkSmall.sigma / 14).toBeLessThan(darkLarge.sigma / 44);
    expect(lightLarge.sigma).toBeLessThan(darkLarge.sigma);
    expect(lightLarge.alpha).toBeLessThan(darkLarge.alpha);
    for (const size of [14, 18, 44, 64]) {
      const reach = size * 0.41 + orbGlowStyle(lilac, true, size).sigma * 3;
      expect(reach).toBeLessThan(size / 2 + orbBleed(size));
    }
  });
});
