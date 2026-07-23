import type { ThemePreference } from "@shared/contracts";

export type ResolvedTheme = Exclude<ThemePreference, "system">;

export function resolveThemePreference(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function nextQuickTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return resolveThemePreference(preference, systemDark) === "dark" ? "light" : "dark";
}
