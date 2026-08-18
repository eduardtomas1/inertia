import {
  COLOR_THEME_IDS,
  type ColorThemeId,
  type ThemePreference,
} from "@shared/contracts/app";

export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_PREFERENCE_CACHE_KEY = "inertia:theme-preference:v1";
export const COLOR_THEME_CACHE_KEY = "inertia:color-theme:v1";

interface ThemePreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function cachedThemePreference(storage: Pick<ThemePreferenceStorage, "getItem">): ThemePreference | null {
  try {
    const value = storage.getItem(THEME_PREFERENCE_CACHE_KEY);
    return value === "system" || value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function isColorThemeId(value: unknown): value is ColorThemeId {
  return typeof value === "string"
    && COLOR_THEME_IDS.includes(value as ColorThemeId);
}

export function cachedColorTheme(
  storage: Pick<ThemePreferenceStorage, "getItem">,
): ColorThemeId | null {
  try {
    const value = storage.getItem(COLOR_THEME_CACHE_KEY);
    return isColorThemeId(value) ? value : null;
  } catch {
    return null;
  }
}

export function cacheThemePreference(storage: Pick<ThemePreferenceStorage, "setItem">, preference: ThemePreference): void {
  try {
    storage.setItem(THEME_PREFERENCE_CACHE_KEY, preference);
  } catch {
    // The main-process cache still protects native first paint when renderer
    // storage is unavailable.
  }
}

export function cacheColorTheme(
  storage: Pick<ThemePreferenceStorage, "setItem">,
  colorTheme: ColorThemeId,
): void {
  try {
    storage.setItem(COLOR_THEME_CACHE_KEY, colorTheme);
  } catch {
    // The persisted runtime snapshot remains authoritative when renderer
    // storage is unavailable.
  }
}

export function resolveThemePreference(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function nextQuickTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return resolveThemePreference(preference, systemDark) === "dark" ? "light" : "dark";
}
