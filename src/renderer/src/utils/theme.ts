import type { ThemePreference } from "@shared/contracts";

export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_PREFERENCE_CACHE_KEY = "inertia:theme-preference:v1";

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

export function cacheThemePreference(storage: Pick<ThemePreferenceStorage, "setItem">, preference: ThemePreference): void {
  try {
    storage.setItem(THEME_PREFERENCE_CACHE_KEY, preference);
  } catch {
    // The main-process cache still protects native first paint when renderer
    // storage is unavailable.
  }
}

export function resolveThemePreference(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function nextQuickTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return resolveThemePreference(preference, systemDark) === "dark" ? "light" : "dark";
}
