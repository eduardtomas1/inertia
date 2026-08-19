import { describe, expect, it } from "vitest";

import {
  COLOR_THEME_CACHE_KEY,
  THEME_PREFERENCE_CACHE_KEY,
  cacheColorTheme,
  cacheThemePreference,
  cachedColorTheme,
  cachedThemePreference,
  isColorThemeId,
  nextQuickTheme,
  resolveThemePreference,
} from "../../src/renderer/src/utils/theme";

describe("theme preferences", () => {
  it("resolves System from the operating-system preference", () => {
    expect(resolveThemePreference("system", true)).toBe("dark");
    expect(resolveThemePreference("system", false)).toBe("light");
  });

  it("makes the quick toggle visibly change even when the saved preference is System", () => {
    expect(nextQuickTheme("system", true)).toBe("light");
    expect(nextQuickTheme("system", false)).toBe("dark");
    expect(nextQuickTheme("light", false)).toBe("dark");
    expect(nextQuickTheme("dark", true)).toBe("light");
  });

  it("uses only validated renderer theme cache values for first paint", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(cachedThemePreference(storage)).toBeNull();
    cacheThemePreference(storage, "dark");
    expect(values.get(THEME_PREFERENCE_CACHE_KEY)).toBe("dark");
    expect(cachedThemePreference(storage)).toBe("dark");
    values.set(THEME_PREFERENCE_CACHE_KEY, "green");
    expect(cachedThemePreference(storage)).toBeNull();

    cacheColorTheme(storage, "ocean");
    expect(values.get(COLOR_THEME_CACHE_KEY)).toBe("ocean");
    expect(cachedColorTheme(storage)).toBe("ocean");
    values.set(COLOR_THEME_CACHE_KEY, "ultraviolet");
    expect(cachedColorTheme(storage)).toBeNull();
  });

  it("accepts only built-in color theme identities", () => {
    expect(isColorThemeId("inertia")).toBe(true);
    expect(isColorThemeId("grove")).toBe(true);
    expect(isColorThemeId("ocean")).toBe(true);
    expect(isColorThemeId("ember")).toBe(true);
    expect(isColorThemeId("iris")).toBe(true);
    expect(isColorThemeId("green")).toBe(false);
    expect(isColorThemeId(null)).toBe(false);
  });
});
