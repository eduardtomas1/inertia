import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SIDEBAR_STAR_BRAND,
  SIDEBAR_STAR_BRAND_CLEARANCE,
  SIDEBAR_STAR_DEPTHS,
  SIDEBAR_STAR_FIELD,
  SIDEBAR_STAR_MACOS_BRAND,
  SIDEBAR_STAR_SPACING,
  SIDEBAR_STAR_TOP_EDGE,
  SIDEBAR_STARFIELD,
  SIDEBAR_STARFIELD_SEED,
  SIDEBAR_STARFIELD_WIDTHS,
  SIDEBAR_STARS_ABOVE_BRAND,
  createSidebarStarfield,
  type SidebarStar,
  type SidebarStarBox,
} from "../../src/renderer/src/components/sidebar/sidebarStarLayout";
import { SIDEBAR_MIN_WIDTH } from "../../src/renderer/src/hooks/useWorkspaceLayout";

/**
 * The logo and name measured in the built app at 276 px, relative to the
 * sidebar: the logo is 19..53 px in both directions; the name ends at 121 px
 * at the default scale and at 127 px at the Large scale (`--text-lg` 21px),
 * where the lockup's hover box ends at 135 px.
 */
const LOGO = { left: 19, top: 19, right: 53, bottom: 53 };
const NAME = {
  default: { left: 65, top: 24, right: 121, bottom: 48 },
  large: { left: 65, top: 22.9, right: 127, bottom: 49.1 },
};
const LARGE_HOVER_BOX_RIGHT = 135;
const RADIUS = { near: 1, far: 0.5 } as const;

const widths = Array.from(
  { length: SIDEBAR_STARFIELD_WIDTHS.max - SIDEBAR_STARFIELD_WIDTHS.min + 1 },
  (_, index) => SIDEBAR_STARFIELD_WIDTHS.min + index,
);

function distance(star: SidebarStar, width: number, box: SidebarStarBox): number {
  const x = (star.x / 100) * width;
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - star.y, 0, star.y - box.bottom);
  return Math.hypot(dx, dy) - RADIUS[star.depth];
}

describe("sidebar starfield", () => {
  it("derives the same sky from the same seed and a different sky from another", () => {
    expect(createSidebarStarfield()).toEqual(SIDEBAR_STARFIELD);
    expect(createSidebarStarfield(SIDEBAR_STARFIELD_SEED)).toEqual(createSidebarStarfield(SIDEBAR_STARFIELD_SEED));
    expect(createSidebarStarfield(SIDEBAR_STARFIELD_SEED + 1)).not.toEqual(SIDEBAR_STARFIELD);
    for (const file of ["sidebarStarLayout.ts", "SidebarStarfield.tsx"]) {
      const source = readFileSync(new URL(`../../src/renderer/src/components/sidebar/${file}`, import.meta.url), "utf8");
      expect(source, file).not.toContain("Math.random");
    }
  });

  it("places a dozen stars at two depths with seeded breathing", () => {
    expect(SIDEBAR_STARFIELD.length).toBeGreaterThanOrEqual(12);
    expect(SIDEBAR_STARFIELD.length).toBeLessThanOrEqual(14);
    expect(SIDEBAR_STARFIELD.filter(({ depth }) => depth === "near")).toHaveLength(SIDEBAR_STAR_DEPTHS.near);
    expect(SIDEBAR_STAR_DEPTHS.near).toBe(4);
    const far = SIDEBAR_STARFIELD.filter(({ depth }) => depth === "far").length;
    expect(far).toBe(SIDEBAR_STAR_DEPTHS.far);
    expect(far).toBeGreaterThanOrEqual(8);
    expect(far).toBeLessThanOrEqual(10);
    for (const star of SIDEBAR_STARFIELD) {
      expect(star.x).toBeGreaterThanOrEqual(SIDEBAR_STAR_FIELD.left);
      expect(star.x).toBeLessThanOrEqual(SIDEBAR_STAR_FIELD.right);
      expect(star.y).toBeGreaterThanOrEqual(SIDEBAR_STAR_FIELD.top);
      expect(star.y).toBeLessThanOrEqual(SIDEBAR_STAR_FIELD.bottom);
      for (const unit of [star.period, star.phase]) {
        expect(unit).toBeGreaterThanOrEqual(0);
        expect(unit).toBeLessThan(1);
      }
    }
    expect(new Set(SIDEBAR_STARFIELD.map(({ phase }) => phase)).size).toBe(SIDEBAR_STARFIELD.length);
  });

  it("keeps the stars sparse: 22 px apart at the default width and wider, leaning to the upper right", () => {
    expect(SIDEBAR_STAR_SPACING).toBe(22);
    const reference = widths.filter((width) => width >= SIDEBAR_STARFIELD_WIDTHS.reference);
    SIDEBAR_STARFIELD.forEach((left, index) => {
      for (const right of SIDEBAR_STARFIELD.slice(index + 1)) {
        for (const width of reference) {
          const gap = Math.hypot(((left.x - right.x) / 100) * width, left.y - right.y);
          expect(gap, `${JSON.stringify(left)} ${JSON.stringify(right)} at ${width}`).toBeGreaterThanOrEqual(SIDEBAR_STAR_SPACING);
        }
      }
    });
    const upper = SIDEBAR_STARFIELD.filter(({ y }) => y < 42).length;
    const right = SIDEBAR_STARFIELD.filter(({ x }) => x > 100 / 3).length;
    expect(upper / SIDEBAR_STARFIELD.length).toBeGreaterThanOrEqual(0.65);
    expect(right / SIDEBAR_STARFIELD.length).toBeGreaterThanOrEqual(0.8);
    expect(SIDEBAR_STARFIELD.filter(({ y }) => y < SIDEBAR_STAR_TOP_EDGE.below).length).toBeLessThanOrEqual(SIDEBAR_STAR_TOP_EDGE.count);
    const aboveBrand = SIDEBAR_STARFIELD.filter(({ x }) =>
      (x / 100) * SIDEBAR_STARFIELD_WIDTHS.min <= SIDEBAR_STAR_BRAND.right + SIDEBAR_STAR_BRAND_CLEARANCE);
    expect(aboveBrand.length).toBeLessThanOrEqual(SIDEBAR_STARS_ABOVE_BRAND);
  });

  it.each(["default", "large"] as const)("keeps every star 14 px from the logo and name at the %s scale at every width", (scale) => {
    expect(SIDEBAR_STARFIELD_WIDTHS.min).toBe(SIDEBAR_MIN_WIDTH);
    expect(SIDEBAR_STAR_BRAND_CLEARANCE).toBe(14);
    expect(SIDEBAR_STAR_BRAND.right + SIDEBAR_STAR_BRAND_CLEARANCE).toBeGreaterThanOrEqual(140);
    expect(SIDEBAR_STAR_BRAND.right + SIDEBAR_STAR_BRAND_CLEARANCE).toBeGreaterThan(LARGE_HOVER_BOX_RIGHT);
    for (const star of SIDEBAR_STARFIELD) {
      for (const width of widths) {
        for (const box of [LOGO, NAME[scale]]) {
          expect(distance(star, width, box), `${JSON.stringify(star)} at ${width}`).toBeGreaterThanOrEqual(SIDEBAR_STAR_BRAND_CLEARANCE);
        }
      }
    }
  });

  it("marks every star that could reach the macOS lockup and leaves some for macOS", () => {
    for (const star of SIDEBAR_STARFIELD) {
      const reaches = widths.some((width) => distance(star, width, SIDEBAR_STAR_MACOS_BRAND) <= 0);
      if (star.macos) expect(reaches, JSON.stringify(star)).toBe(false);
    }
    expect(SIDEBAR_STARFIELD.filter((star) => star.macos).length).toBeGreaterThanOrEqual(5);
  });
});
