import { readFileSync, writeFileSync } from "node:fs";

export type WindowThemePreference = "system" | "light" | "dark";

export const WINDOW_APPEARANCE_FILENAME = "window-appearance.json";
export const WINDOW_BACKGROUND = {
  light: "#f1f1f3",
  dark: "#101013",
} as const;

export function isWindowThemePreference(value: unknown): value is WindowThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function parseWindowThemePreference(value: unknown): WindowThemePreference {
  if (typeof value !== "object" || value === null) return "system";
  const preference = Reflect.get(value, "theme");
  return isWindowThemePreference(preference) ? preference : "system";
}

export function readWindowThemePreference(path: string): WindowThemePreference {
  try {
    return parseWindowThemePreference(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return "system";
  }
}

export function writeWindowThemePreference(path: string, theme: WindowThemePreference): void {
  writeFileSync(path, JSON.stringify({ theme }), { encoding: "utf8", mode: 0o600 });
}

export function resolveWindowBackground(theme: WindowThemePreference, systemDark: boolean): string {
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  return WINDOW_BACKGROUND[resolved];
}
