import type { AppSettings } from "@shared/contracts";
import { defaultSettings } from "@shared/contracts/app";

import { cachedCustomColor } from "./customTheme";
import { layoutStorage } from "./layoutStorage";
import { cachedColorTheme, cachedThemePreference } from "./theme";

export function cachedAppSettings(): AppSettings {
  return {
    ...defaultSettings,
    lightCustomColor: cachedCustomColor(layoutStorage, "light"),
    darkCustomColor: cachedCustomColor(layoutStorage, "dark"),
    theme: cachedThemePreference(layoutStorage) ?? defaultSettings.theme,
    colorTheme: cachedColorTheme(layoutStorage)
      ?? defaultSettings.colorTheme,
    lightColorTheme: cachedColorTheme(layoutStorage, "light") ?? defaultSettings.colorTheme,
    darkColorTheme: cachedColorTheme(layoutStorage, "dark") ?? defaultSettings.colorTheme,
  };
}
