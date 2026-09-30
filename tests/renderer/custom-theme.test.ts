import { describe, expect, it } from "vitest";
import { buildCustomPaletteTokens, buildPaletteTokens } from "../../src/shared/theme/color-theme-spec";
import { contrastRatio, hexToOklch } from "../../src/shared/theme/color-palette";
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
