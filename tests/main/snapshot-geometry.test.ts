import { describe, expect, it } from "vitest";
import { snapshotImageScale, snapshotMaskRect } from "../../src/main/snapshot-geometry";

describe("snapshot mask geometry", () => {
  it("maps point masks onto a Retina image of the window", () => {
    const frame = { x: 100, y: 40, width: 800, height: 600 };
    const scale = snapshotImageScale(frame, { width: 1600, height: 1200 }, 0.02)!;
    expect(scale).toEqual({ x: 2, y: 2 });
    expect(snapshotMaskRect({ x: 110, y: 50, width: 30, height: 12 }, frame, scale)).toEqual({ x: 18, y: 18, width: 64, height: 28 });
  });

  it("maps windows on a display left of or above the primary display", () => {
    const frame = { x: -1440, y: -300, width: 720, height: 450 };
    const scale = snapshotImageScale(frame, { width: 1440, height: 900 })!;
    expect(snapshotMaskRect({ x: -1400, y: -280, width: 100, height: 20 }, frame, scale)).toEqual({ x: 78, y: 38, width: 204, height: 44 });
  });

  it("covers every partially covered pixel at fractional scales", () => {
    const frame = { x: 0, y: 0, width: 100, height: 100 };
    const scale = snapshotImageScale(frame, { width: 150, height: 150 })!;
    const mask = snapshotMaskRect({ x: 10.3, y: 20.7, width: 5.1, height: 3.3 }, frame, scale);
    expect(mask.x).toBeLessThanOrEqual(Math.floor(10.3 * 1.5) - 2);
    expect(mask.y).toBeLessThanOrEqual(Math.floor(20.7 * 1.5) - 2);
    expect(mask.x + mask.width).toBeGreaterThanOrEqual(Math.ceil(15.4 * 1.5) + 2);
    expect(mask.y + mask.height).toBeGreaterThanOrEqual(Math.ceil(24 * 1.5) + 2);
  });

  it("accepts a window image rounded to whole pixels", () => {
    expect(snapshotImageScale({ x: 0, y: 0, width: 333, height: 201 }, { width: 666, height: 403 }, 0.02)).not.toBeNull();
  });

  it.each([
    [{ width: 200, height: 150 }, 0.02],
    [{ width: 0, height: 200 }, Infinity],
    [{ width: 200, height: Number.NaN }, Infinity],
  ])("reports no usable scale for %o", (image, tolerance) => {
    expect(snapshotImageScale({ x: 0, y: 0, width: 100, height: 100 }, image, tolerance)).toBeNull();
  });
});
