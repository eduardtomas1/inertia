import { describe, expect, it } from "vitest";
import { buildPaletteTokens, PALETTE_FAMILIES } from "../../scripts/color-theme-spec.mjs";
import { adaptProjectColor, contrastRatio } from "../../src/shared/project-color-contrast";
import {
  normalizeProjectHexColor,
  PROJECT_COLOR_BACKDROPS,
  PROJECT_COLOR_NAMES,
  PROJECT_COLOR_PALETTE,
  type ProjectColorAppearance,
} from "../../src/shared/project-colors";

const APPEARANCES: readonly ProjectColorAppearance[] = ["light", "dark"];
const LADDER = ["app-bg", "sidebar-bg", "surface", "surface-strong", "surface-muted", "surface-hover"] as const;
const WCAG_AA_TEXT = 4.5;

function surfaces(appearance: ProjectColorAppearance): string[] {
  return PALETTE_FAMILIES.flatMap((family) => {
    const tokens = Object.fromEntries(buildPaletteTokens(family, appearance)) as Record<string, string>;
    return LADDER.map((role) => tokens[role]!);
  });
}

function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function hue(hex: string): number {
  const [, a, b] = oklab(hex);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

describe("project colour palette", () => {
  it.each(APPEARANCES)("keeps every palette tint readable as text on every %s theme surface", (appearance) => {
    const backgrounds = surfaces(appearance);
    for (const name of PROJECT_COLOR_NAMES) {
      const tint = PROJECT_COLOR_PALETTE[name][appearance];
      for (const background of backgrounds) {
        expect(contrastRatio(tint, background), `${name} ${appearance} on ${background}`).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
      }
    }
  });

  it.each(APPEARANCES)("keeps the %s palette distinguishable, one hue per swatch", (appearance) => {
    const tints = PROJECT_COLOR_NAMES.map((name) => oklab(PROJECT_COLOR_PALETTE[name][appearance]));
    for (const [index, left] of tints.entries()) {
      for (const right of tints.slice(index + 1)) {
        expect(Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2])).toBeGreaterThan(0.07);
      }
    }
    expect(new Set(Object.values(PROJECT_COLOR_PALETTE).map(({ label }) => label)).size).toBe(PROJECT_COLOR_NAMES.length);
  });

  it("tracks the most demanding generated surface of every colour theme family", () => {
    for (const appearance of APPEARANCES) {
      expect(PROJECT_COLOR_BACKDROPS[appearance]).toEqual(PALETTE_FAMILIES.map((family) => (
        Object.fromEntries(buildPaletteTokens(family, appearance)) as Record<string, string>
      )["surface-hover"]));
    }
  });
});

describe("custom project colours", () => {
  it("adapts any custom colour to AA text contrast in both themes while keeping its hue", () => {
    const samples = Array.from({ length: 36 }, (_, index) => index * 10).flatMap((degrees) => [0.2, 0.5, 0.85].map((lightness) => {
      const radians = (degrees * Math.PI) / 180;
      const [a, b] = [Math.cos(radians) * 0.12, Math.sin(radians) * 0.12];
      const lms = [lightness + 0.3963377774 * a + 0.2158037573 * b, lightness - 0.1055613458 * a - 0.0638541728 * b, lightness - 0.0894841775 * a - 1.2914855480 * b].map((value) => value ** 3) as [number, number, number];
      const linear = [
        4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
        -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
        -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.7076147010 * lms[2],
      ].map((value) => Math.min(1, Math.max(0, value)));
      return `#${linear.map((value) => Math.round((value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055) * 255).toString(16).padStart(2, "0")).join("")}`;
    }));
    for (const appearance of APPEARANCES) {
      const backgrounds = surfaces(appearance);
      for (const sample of samples) {
        const adapted = adaptProjectColor(sample, appearance);
        for (const background of backgrounds) {
          expect(contrastRatio(adapted, background), `${sample} ${appearance} on ${background}`).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
        }
        if (oklab(sample)[1] ** 2 + oklab(sample)[2] ** 2 > 0.05 ** 2) {
          const drift = Math.abs(hue(adapted) - hue(sample));
          expect(Math.min(drift, 360 - drift), `${sample} ${appearance}`).toBeLessThan(12);
        }
      }
    }
  });

  it("leaves an already readable custom colour unchanged", () => {
    expect(adaptProjectColor("#5aa3ec", "dark")).toBe("#5aa3ec");
    expect(adaptProjectColor("#105ea0", "light")).toBe("#105ea0");
    expect(adaptProjectColor("#1a1a1a", "dark")).not.toBe("#1a1a1a");
    expect(adaptProjectColor("#fafafa", "light")).not.toBe("#fafafa");
  });

  it("normalises hex input and rejects anything else", () => {
    expect(normalizeProjectHexColor("#3A86FF")).toBe("#3a86ff");
    expect(normalizeProjectHexColor(" 3a86ff ")).toBe("#3a86ff");
    expect(normalizeProjectHexColor("#abc")).toBe("#aabbcc");
    for (const value of ["", "#12345", "#1234567", "red", "rgb(0,0,0)", "#ggghhh", null, 42, {}]) {
      expect(normalizeProjectHexColor(value)).toBeNull();
    }
  });
});
