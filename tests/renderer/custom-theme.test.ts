import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCustomPaletteTokens, buildPaletteTokens, FILL_INK, inkOver, PALETTE_FAMILIES } from "../../src/shared/theme/color-theme-spec";
import { contrastRatio, hexToOklch, oklchToHex } from "../../src/shared/theme/color-palette";
import { cacheCustomColor, cachedCustomColor, CUSTOM_COLOR_CACHE_KEY } from "../../src/renderer/src/utils/customTheme";

const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#000000", "#ffffff", "#808080", "#3a86ff"];
const modes = ["light", "dark"] as const;

describe("custom appearance palettes", () => {
  it.each(modes)("preserves the Inertia %s roles, elevations, and readable contrast", (mode) => {
    const builtIn = Object.fromEntries(buildPaletteTokens("inertia", mode));
    for (const color of colors) {
      const palette = Object.fromEntries(buildCustomPaletteTokens(color, mode));
      expect(Object.keys(palette)).toEqual(Object.keys(builtIn));
      for (const role of ["app-bg", "sidebar-bg", "surface", "surface-strong", "surface-muted", "surface-hover"]) {
        expect(Math.abs(hexToOklch(palette[role]!).l - hexToOklch(builtIn[role]!).l)).toBeLessThan(0.006);
        expect(contrastRatio(palette.text!, palette[role]!)).toBeGreaterThanOrEqual(7);
        for (const text of ["text-muted", "danger", "warning", "status-completed", "status-input"]) {
          expect(contrastRatio(palette[text]!, palette[role]!), `${color} ${text} on ${role}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrastRatio(palette["accent-text"]!, palette.accent!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(modes)("keeps grayscale choices neutral in %s mode", (mode) => {
    for (const color of ["#000000", "#ffffff", "#808080"]) {
      const palette = Object.fromEntries(buildCustomPaletteTokens(color, mode));
      for (const role of ["app-bg", "accent", "accent-soft"]) {
        expect(hexToOklch(palette[role]!).c).toBeLessThan(0.001);
      }
    }
  });

  it("keeps the preset palettes byte-identical and pins the vivid custom palettes", () => {
    const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(digest(PALETTE_FAMILIES.flatMap((family) => modes.map((mode) => [family, mode, buildPaletteTokens(family, mode)]))))
      .toBe("7c1924ea5dd8e8a22e6b68c8949df441e0047823326255dc156637522bf1f026");
    expect(digest([...colors, "#0d9488", "#f97316"].flatMap((color) => modes.map((mode) => [color, mode, buildCustomPaletteTokens(color, mode)]))))
      .toBe("1542431ee0c69b37df6a1ea29f0b7efbd2bad84408566dcd013ba01925706f1d");
  });

  it.each(modes)("uses the picked colour as the %s accent and moves it only as far as contrast requires", (mode) => {
    const seeds = Array.from({ length: 24 }, (_, index) => oklchToHex({ l: 0.62, c: 0.25, h: index * 15 }));
    for (const color of [...seeds, ...colors, "#0d9488", "#f97316", "#2bc7b8", "#a3e635", "#1e3a8a"]) {
      const palette = Object.fromEntries(buildCustomPaletteTokens(color, mode));
      const guards = ["app-bg", "sidebar-bg", "surface", "surface-strong", "terminal-bg"].map((role) => palette[role]!);
      const passes = (hex: string, target: number) => guards.every((background) => contrastRatio(hex, background) >= target);
      if (passes(color, 3)) {
        expect(palette.accent, `${color} accent`).toBe(color);
      } else {
        expect(passes(palette.accent!, 3), `${color} accent guard`).toBe(true);
        expect(Math.min(...guards.map((background) => contrastRatio(palette.accent!, background))), `${color} accent clamp`).toBeLessThan(3.15);
        expect(Math.sign(hexToOklch(palette.accent!).l - hexToOklch(color).l)).toBe(mode === "light" ? -1 : 1);
      }
      if (passes(color, 4.5)) expect(palette["accent-strong"], `${color} accent-strong`).toBe(color);
      for (const fill of ["accent", "accent-hover"]) {
        expect(contrastRatio(palette["accent-text"]!, palette[fill]!), `${color} accent-text on ${fill}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(modes)("would leave every preset %s accent as it is", (mode) => {
    for (const family of PALETTE_FAMILIES) {
      const preset = Object.fromEntries(buildPaletteTokens(family, mode));
      const seeded = Object.fromEntries(buildCustomPaletteTokens(preset.accent!, mode));
      expect(seeded.accent, `${family} ${mode}`).toBe(preset.accent);
      for (const role of ["app-bg", "sidebar-bg", "surface", "surface-strong", "terminal-bg"]) {
        expect(contrastRatio(preset.accent!, preset[role]!), `${family} ${mode} on ${role}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it.each(modes)("mutes a custom %s palette without changing its roles or elevations", (mode) => {
    for (const color of ["#0d9488", "#f97316", "#ff00ff", "#3a86ff", "#00ff00"]) {
      const vivid = Object.fromEntries(buildCustomPaletteTokens(color, mode));
      const muted = Object.fromEntries(buildCustomPaletteTokens(color, mode, true));
      expect(Object.keys(muted)).toEqual(Object.keys(vivid));
      expect(buildCustomPaletteTokens(color, mode, true)).toEqual(buildCustomPaletteTokens(color, mode, true));
      for (const role of ["app-bg", "sidebar-bg", "surface", "surface-strong", "accent-soft", "terminal-bg"]) {
        expect(Math.abs(hexToOklch(muted[role]!).l - hexToOklch(vivid[role]!).l), `${color} ${role} lightness`).toBeLessThan(0.006);
      }
      for (const role of ["app-bg", "surface", "accent-soft", "terminal-selection"]) {
        expect(hexToOklch(muted[role]!).c, `${color} ${role} chroma`).toBeLessThanOrEqual(hexToOklch(vivid[role]!).c * 0.55 + 0.002);
      }
      for (const role of ["accent", "accent-hover", "accent-strong"]) {
        expect(hexToOklch(muted[role]!).c, `${color} ${role} chroma`).toBeLessThanOrEqual(hexToOklch(color).c * 0.5 + 0.002);
      }
      expect(Math.abs(hexToOklch(muted.accent!).h - hexToOklch(vivid.accent!).h) % 360).toBeLessThan(8);
    }
  });

  it.each(modes)("keeps text, accent and terminal contrast across the hue wheel in %s mode", (mode) => {
    const seeds = Array.from({ length: 24 }, (_, index) => oklchToHex({ l: 0.62, c: 0.25, h: index * 15 }));
    for (const color of [...seeds, ...colors]) {
      for (const muted of [false, true]) {
        const palette = Object.fromEntries(buildCustomPaletteTokens(color, mode, muted));
        const label = `${color}${muted ? " muted" : ""}`;
        for (const role of ["app-bg", "sidebar-bg", "surface", "surface-strong", "surface-muted", "surface-hover"]) {
          expect(contrastRatio(palette.text!, palette[role]!), `${label} text on ${role}`).toBeGreaterThanOrEqual(7);
          for (const text of ["text-muted"]) {
            expect(contrastRatio(palette[text]!, palette[role]!), `${label} ${text} on ${role}`).toBeGreaterThanOrEqual(4.5);
          }
        }
        for (const role of ["app-bg", "sidebar-bg", "surface", "surface-strong"]) {
          expect(contrastRatio(palette.accent!, palette[role]!), `${label} accent on ${role}`).toBeGreaterThanOrEqual(3);
          expect(contrastRatio(palette["accent-strong"]!, palette[role]!), `${label} accent-strong on ${role}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastRatio(palette["accent-text"]!, palette.accent!), `${label} accent-text`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.text!, palette["accent-soft"]!), `${label} text on accent-soft`).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(palette["terminal-fg"]!, palette["terminal-bg"]!), `${label} terminal`).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(palette["terminal-fg"]!, palette["terminal-selection"]!), `${label} terminal selection`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.accent!, palette["terminal-bg"]!), `${label} terminal cursor`).toBeGreaterThanOrEqual(3);
        const raised = mode === "light" ? palette["surface-strong"]! : palette["surface-muted"]!;
        for (const background of [palette.surface!, palette["surface-strong"]!, raised]) {
          const code = inkOver(palette.text!, background, FILL_INK);
          for (const syntax of ["syntax-keyword", "syntax-string", "syntax-function", "syntax-comment"]) {
            expect(contrastRatio(palette[syntax]!, code), `${label} ${syntax} on ${code}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });

  it("caches independent seeds and clears a custom selection without losing the other mode", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    cacheCustomColor(storage, "#3a86ff", "light");
    cacheCustomColor(storage, "#ff00ff", "dark");
    expect(cachedCustomColor(storage, "light")).toBe("#3a86ff");
    expect(cachedCustomColor(storage, "dark")).toBe("#ff00ff");
    cacheCustomColor(storage, null, "light");
    expect(cachedCustomColor(storage, "light")).toBeNull();
    expect(cachedCustomColor(storage, "dark")).toBe("#ff00ff");
    values.set(`${CUSTOM_COLOR_CACHE_KEY}:light`, '{"color":"red"}');
    expect(cachedCustomColor(storage, "light")).toBeNull();
    values.set(`${CUSTOM_COLOR_CACHE_KEY}:light`, "invalid JSON");
    expect(cachedCustomColor(storage, "light")).toBeNull();
    expect(cachedCustomColor({ getItem: () => { throw new Error("blocked"); } }, "light")).toBeNull();
  });
});
