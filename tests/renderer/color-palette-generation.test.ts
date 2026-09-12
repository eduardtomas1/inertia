import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  gamutMapChroma,
  maxChromaAt,
  oklchToHex,
} from "../../scripts/color-palette.mjs";
import {
  ARCHITECTURE,
  BASE_NEUTRAL_CHROMA,
  FAMILY_SPECS,
  PALETTE_APPEARANCES,
  PALETTE_FAMILIES,
  buildPaletteTokens,
} from "../../scripts/color-theme-spec.mjs";
import {
  renderFiles,
  windowBackground,
} from "../../scripts/generate-color-themes.mjs";
import { WINDOW_BACKGROUND } from "../../src/main/window-appearance";
import { COLOR_THEME_IDS } from "../../src/shared/contracts";

const repoFile = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function oklchOf(hex: string): { l: number; c: number; h: number } {
  const decode = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((offset) =>
    decode(Number.parseInt(hex.slice(offset, offset + 2), 16)));
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  const lightness = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return {
    l: lightness,
    c: Math.hypot(a, bb),
    h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
  };
}

const LADDER_ROLES = [
  "app-bg",
  "sidebar-bg",
  "surface",
  "surface-strong",
  "surface-muted",
  "surface-hover",
] as const;

const palette = (family: string, appearance: string): Record<string, string> =>
  Object.fromEntries(buildPaletteTokens(family as never, appearance as never));

const cases = PALETTE_FAMILIES.flatMap((family) =>
  PALETTE_APPEARANCES.map((appearance) => [family, appearance] as const));

describe("generated color palettes", () => {
  it("keeps the committed palette CSS identical to the generated palette", () => {
    for (const [path, expected] of Object.entries(renderFiles(repoFile))) {
      expect(repoFile(path), `${path} is stale; run npm run generate:color-themes`)
        .toBe(expected);
    }
  });

  it("covers exactly the shipped color theme identities", () => {
    expect([...PALETTE_FAMILIES]).toEqual([...COLOR_THEME_IDS]);
  });

  it("paints the native window with the palette's own canvas", () => {
    expect(WINDOW_BACKGROUND.light).toBe(windowBackground("light"));
    expect(WINDOW_BACKGROUND.dark).toBe(windowBackground("dark"));
  });

  it.each(cases)("builds every %s %s ramp step from one hue and one tint", (family, appearance) => {
    const tokens = palette(family, appearance);
    const spec = FAMILY_SPECS[family]!;
    const ladder = ARCHITECTURE[appearance]!.ladder as Record<string, number>;
    const tint = BASE_NEUTRAL_CHROMA[appearance]! * spec.neutralTint;
    for (const role of LADDER_ROLES) {
      expect(tokens[role], `${family} ${appearance} --${role}`).toBe(
        oklchToHex({ l: ladder[role]!, c: tint, h: spec.neutralHue }),
      );
    }
  });

  it.each(cases)("spaces the %s %s elevation ramp evenly in lightness", (family, appearance) => {
    const tokens = palette(family, appearance);
    const ordered = [...LADDER_ROLES]
      .map((role) => oklchOf(tokens[role]!).l)
      .sort((left, right) => left - right);
    const steps = ordered.slice(1).map((value, index) => value - ordered[index]!);
    const span = ordered.at(-1)! - ordered[0]!;
    expect(span, `${family} ${appearance} ramp span`).toBeGreaterThan(0.09);
    expect(Math.max(...steps) / Math.min(...steps), `${family} ${appearance} step evenness`)
      .toBeLessThan(2);
  });

  it.each(cases)("gives the %s %s status roles one lightness and chroma budget", (family, appearance) => {
    const tokens = palette(family, appearance);
    const roles = ["danger", "warning", "status-completed", "status-working"];
    const measured = roles.map((role) => oklchOf(tokens[role]!));
    const lightness = measured.map(({ l }) => l);
    const chroma = measured.map(({ c }) => c);
    expect(Math.max(...lightness) - Math.min(...lightness)).toBeLessThan(0.04);
    expect(Math.max(...chroma) - Math.min(...chroma)).toBeLessThan(0.03);
  });

  it.each(cases)("keeps the %s %s text ramp strictly descending", (family, appearance) => {
    const tokens = palette(family, appearance);
    const surface = tokens.surface!;
    const ratios = ["text", "text-soft", "text-muted"]
      .map((role) => contrastRatio(tokens[role]!, surface));
    expect(ratios[0]).toBeGreaterThan(ratios[1]!);
    expect(ratios[1]).toBeGreaterThan(ratios[2]!);
    expect(ratios[2]).toBeGreaterThanOrEqual(4.5);
    expect(ratios[0]).toBeGreaterThanOrEqual(7);
  });

  it.each(cases)("agrees on the semantic hue for %s %s blue and working", (family, appearance) => {
    const tokens = palette(family, appearance);
    expect(tokens.blue).toBe(tokens["status-working"]);
    expect(tokens.danger).toBe(tokens["status-failed"]);
    expect(tokens.warning).toBe(tokens["status-approval"]);
  });

  it("maps out-of-gamut requests by reducing chroma only", () => {
    const requested = { l: 0.5, c: 0.4, h: 150 };
    const mapped = gamutMapChroma(requested);
    expect(mapped.l).toBe(requested.l);
    expect(mapped.h).toBe(requested.h);
    expect(mapped.c).toBeLessThan(requested.c);
    expect(oklchToHex(requested)).toBe(oklchToHex(mapped));
  });

  it("does not leave usable chroma unspent on muted semantic roles", () => {
    for (const [family, appearance] of cases) {
      const tokens = palette(family, appearance);
      const green = oklchOf(tokens["status-completed"]!);
      const budget = ARCHITECTURE[appearance]!.statusChroma as number;
      const reachable = maxChromaAt(green.l, green.h, budget);
      expect(green.c, `${family} ${appearance} status-completed chroma`)
        .toBeGreaterThan(reachable * 0.9);
    }
  });
});
