import { readFileSync, writeFileSync } from "node:fs";

import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from "electron";

import { MAC_TRAFFIC_LIGHT_POSITION, WINDOW_HEADER_HEIGHT } from "../shared/window-chrome.js";

export type WindowThemePreference = "system" | "light" | "dark";
export type ResolvedWindowTheme = "light" | "dark";

export const WINDOW_APPEARANCE_FILENAME = "window-appearance.json";
export const WINDOW_BACKGROUND = {
  light: "#fafafd",
  dark: "#18181b",
} as const;
export const WINDOW_TITLE_BAR_SYMBOL = {
  light: "#212126",
  dark: "#ededf7",
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

export function resolveWindowTheme(theme: WindowThemePreference, systemDark: boolean): ResolvedWindowTheme {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

export function resolveWindowBackground(theme: WindowThemePreference, systemDark: boolean): string {
  return WINDOW_BACKGROUND[resolveWindowTheme(theme, systemDark)];
}

export function windowTitleBarOverlay(theme: ResolvedWindowTheme): TitleBarOverlayOptions {
  return { color: "#00000000", symbolColor: WINDOW_TITLE_BAR_SYMBOL[theme], height: WINDOW_HEADER_HEIGHT };
}

export function windowChromeOptions(
  platform: NodeJS.Platform,
  theme: ResolvedWindowTheme,
): Pick<BrowserWindowConstructorOptions, "backgroundColor" | "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"> {
  const backgroundColor = WINDOW_BACKGROUND[theme];
  if (platform === "darwin") {
    return { backgroundColor, titleBarStyle: "hiddenInset", trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION };
  }
  if (platform === "win32") {
    return { backgroundColor, titleBarStyle: "hidden", titleBarOverlay: windowTitleBarOverlay(theme) };
  }
  return { backgroundColor };
}

export interface ThemedWindow {
  setBackgroundColor(backgroundColor: string): void;
  setTitleBarOverlay(options: TitleBarOverlayOptions): void;
}

export function applyWindowTheme(window: ThemedWindow, platform: NodeJS.Platform, theme: ResolvedWindowTheme): void {
  window.setBackgroundColor(WINDOW_BACKGROUND[theme]);
  if (platform === "win32") window.setTitleBarOverlay(windowTitleBarOverlay(theme));
}
