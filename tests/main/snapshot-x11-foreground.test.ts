import { expect, it } from "vitest";
import { matchesX11Bounds } from "../../src/main/snapshot-x11-foreground";

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
