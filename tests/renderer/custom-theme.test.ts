import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCustomPaletteTokens, buildPaletteTokens, PALETTE_FAMILIES } from "../../src/shared/theme/color-theme-spec";
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
        for (const text of ["text-soft", "text-muted", "danger", "warning", "status-completed", "status-input"]) {
          expect(contrastRatio(palette[text]!, palette[role]!), `${color} ${text} on ${role}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrastRatio(palette["accent-text"]!, palette.accent!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(modes)("keeps grayscale choices neutral in %s mode", (mode) => {
    for (const color of ["#000000", "#ffffff", "#808080"]) {
      const palette = Object.fromEntries(buildCustomPaletteTokens(color, mode));
      for (const role of ["app-bg", "accent", "accent-soft", "message-action", "aurora-1"]) {
        expect(hexToOklch(palette[role]!).c).toBeLessThan(0.001);
      }
    }
  });

  it("keeps the preset palettes and the vivid custom palettes byte-identical", () => {
    const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(digest(PALETTE_FAMILIES.flatMap((family) => modes.map((mode) => [family, mode, buildPaletteTokens(family, mode)]))))
      .toBe("5e888df5b571fb4c5d686f8bffedd73c2307619344e5b81fb99fc83ac391dbef");
    expect(digest([...colors, "#0d9488", "#f97316"].flatMap((color) => modes.map((mode) => [color, mode, buildCustomPaletteTokens(color, mode)]))))
      .toBe("bbe22750226c38ff901452c74412898ee0d927758d931286d65338468bed93b5");
  });

  it.each(modes)("mutes a custom %s palette without changing its roles or elevations", (mode) => {
    for (const color of ["#0d9488", "#f97316", "#ff00ff", "#3a86ff", "#00ff00"]) {
      const vivid = Object.fromEntries(buildCustomPaletteTokens(color, mode));
      const muted = Object.fromEntries(buildCustomPaletteTokens(color, mode, true));
      expect(Object.keys(muted)).toEqual(Object.keys(vivid));
      expect(buildCustomPaletteTokens(color, mode, true)).toEqual(buildCustomPaletteTokens(color, mode, true));
      for (const role of ["app-bg", "sidebar-bg", "surface", "surface-strong", "accent", "accent-soft", "terminal-bg"]) {
        expect(Math.abs(hexToOklch(muted[role]!).l - hexToOklch(vivid[role]!).l), `${color} ${role} lightness`).toBeLessThan(0.006);
      }
      for (const role of ["app-bg", "surface", "accent", "accent-soft", "accent-strong", "message-action", "terminal-selection", "aurora-1"]) {
        expect(hexToOklch(muted[role]!).c, `${color} ${role} chroma`).toBeLessThanOrEqual(hexToOklch(vivid[role]!).c * 0.55 + 0.002);
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
          for (const text of ["text-soft", "text-muted"]) {
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
        for (const syntax of ["syntax-keyword", "syntax-string", "syntax-function", "syntax-comment"]) {
          expect(contrastRatio(palette[syntax]!, palette["code-surface"]!), `${label} ${syntax}`).toBeGreaterThanOrEqual(4.5);
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
