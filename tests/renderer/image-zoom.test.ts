import { describe, expect, it } from "vitest";

import {
  IDENTITY_IMAGE_ZOOM,
  IMAGE_ZOOM_MAX_SCALE,
  IMAGE_ZOOM_MIN_SCALE,
  clampImageScale,
  clampImageZoom,
  containedImageBounds,
  imageZoomPercentLabel,
  panImageZoom,
  steppedZoomScale,
  wheelZoomScale,
  zoomImageAtPoint,
  type ImageZoomBounds,
} from "../../src/renderer/src/utils/imageZoom";

// A 400x300 stage showing a 800x400 bitmap: contain fits it to 400x200.
const bounds: ImageZoomBounds = containedImageBounds(400, 300, 800, 400);

describe("image zoom arithmetic", () => {
  it("fits the bitmap into the stage with contain geometry", () => {
    expect(bounds).toEqual({
      viewportWidth: 400,
      viewportHeight: 300,
      contentWidth: 400,
      contentHeight: 200,
    });
  });

  it("falls back to the stage when the bitmap has not decoded", () => {
    expect(containedImageBounds(400, 300, 0, 0)).toEqual({
      viewportWidth: 400,
      viewportHeight: 300,
      contentWidth: 400,
      contentHeight: 300,
    });
  });

  it("keeps the scale between the fitted and maximum zoom", () => {
    expect(clampImageScale(0.2)).toBe(IMAGE_ZOOM_MIN_SCALE);
    expect(clampImageScale(40)).toBe(IMAGE_ZOOM_MAX_SCALE);
    expect(clampImageScale(Number.NaN)).toBe(IMAGE_ZOOM_MIN_SCALE);
    expect(clampImageScale(2.5)).toBe(2.5);
  });

  it("refuses to pan a fitted image", () => {
    expect(panImageZoom(IDENTITY_IMAGE_ZOOM, bounds, { x: 120, y: 90 }))
      .toEqual(IDENTITY_IMAGE_ZOOM);
  });

  it("stops panning where the image would uncover the stage", () => {
    // At 2x the content is 800x400 against a 400x300 stage: 200px of
    // horizontal travel and 50px of vertical travel each way.
    const zoomed = { scale: 2, offsetX: 0, offsetY: 0 };
    expect(panImageZoom(zoomed, bounds, { x: 500, y: 500 }))
      .toEqual({ scale: 2, offsetX: 200, offsetY: 50 });
    expect(panImageZoom(zoomed, bounds, { x: -500, y: -500 }))
      .toEqual({ scale: 2, offsetX: -200, offsetY: -50 });
    expect(panImageZoom(zoomed, bounds, { x: 30, y: -10 }))
      .toEqual({ scale: 2, offsetX: 30, offsetY: -10 });
  });

  it("holds the focused point still while zooming in", () => {
    // 100px right of centre at 1x must stay 100px right of centre at 2x.
    const next = zoomImageAtPoint(IDENTITY_IMAGE_ZOOM, bounds, 2, {
      x: 100,
      y: 0,
    });
    expect(next.scale).toBe(2);
    expect(next.offsetX).toBe(-100);
    expect(next.offsetY).toBe(0);
  });

  it("re-centres when zooming back out to the fitted scale", () => {
    const zoomed = zoomImageAtPoint(IDENTITY_IMAGE_ZOOM, bounds, 4, {
      x: 180,
      y: 120,
    });
    expect(zoomImageAtPoint(zoomed, bounds, 1, { x: 180, y: 120 }))
      .toEqual(IDENTITY_IMAGE_ZOOM);
  });

  it("clamps a zoomed offset back inside the stage when it shrinks", () => {
    const wide = { scale: 4, offsetX: 600, offsetY: 400 };
    expect(clampImageZoom(wide, bounds))
      .toEqual({ scale: 4, offsetX: 600, offsetY: 250 });
    expect(clampImageZoom(wide, containedImageBounds(400, 300, 800, 400)))
      .toEqual({ scale: 4, offsetX: 600, offsetY: 250 });
  });

  it("steps geometrically and stays inside the limits", () => {
    expect(steppedZoomScale(1, 1)).toBeCloseTo(1.5, 5);
    expect(steppedZoomScale(1, -1)).toBe(IMAGE_ZOOM_MIN_SCALE);
    expect(steppedZoomScale(IMAGE_ZOOM_MAX_SCALE, 1))
      .toBe(IMAGE_ZOOM_MAX_SCALE);
    expect(steppedZoomScale(3, -1)).toBe(2);
  });

  it("zooms in on wheel-up and out on wheel-down", () => {
    expect(wheelZoomScale(2, -320)).toBeCloseTo(2 * Math.E, 5);
    expect(wheelZoomScale(4, 320)).toBeCloseTo(4 / Math.E, 5);
    expect(wheelZoomScale(1, 320)).toBe(IMAGE_ZOOM_MIN_SCALE);
  });

  it("labels the zoom level as a rounded percentage", () => {
    expect(imageZoomPercentLabel(1)).toBe("100%");
    expect(imageZoomPercentLabel(2.345)).toBe("235%");
    expect(imageZoomPercentLabel(0.1)).toBe("100%");
  });
});
