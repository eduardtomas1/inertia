import { expect, it } from "vitest";
import { matchesX11Bounds, x11CaptureBounds } from "../../src/main/snapshot-x11-foreground";

const logical = { x: -200, y: 40, width: 800, height: 600 };
it("matches physical X11 geometry to logical accessibility geometry on scaled and negative-origin displays", () => {
  for (const scale of [1, 1.25, 2]) expect(matchesX11Bounds(logical, {
    x: logical.x * scale, y: logical.y * scale, width: logical.width * scale, height: logical.height * scale,
  })).toBe(true);
});
it("refuses a differently positioned or shaped same-title window and invalid geometry", () => {
  expect(matchesX11Bounds(logical, { ...logical, x: 200 })).toBe(false);
  expect(matchesX11Bounds(logical, { ...logical, height: 500 })).toBe(false);
  expect(matchesX11Bounds(null, logical)).toBe(false);
  expect(matchesX11Bounds({ ...logical, width: 0 }, logical)).toBe(false);
  expect(matchesX11Bounds({ ...logical, y: NaN }, logical)).toBe(false);
});

it("matches the decorated frame while keeping captured pixels within the native client", () => {
  const bounds = { x: 320, y: 272, width: 640, height: 480 };
  const frameBounds = { x: 319, y: 252, width: 642, height: 505 };
  for (const scale of [1, 1.25, 2]) {
    const scaled = (rect: typeof bounds) => ({ x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale });
    expect(x11CaptureBounds(scaled(frameBounds), { bounds, frameBounds })).toEqual(scaled(bounds));
    expect(x11CaptureBounds(scaled(bounds), { bounds, frameBounds })).toEqual(scaled(bounds));
  }
  expect(x11CaptureBounds({ ...frameBounds, x: frameBounds.x + 2 }, { bounds, frameBounds })).toBeNull();
  expect(x11CaptureBounds({ ...frameBounds, height: frameBounds.height + 2 }, { bounds, frameBounds })).toBeNull();
  expect(x11CaptureBounds(null, { bounds, frameBounds })).toBeNull();
});
