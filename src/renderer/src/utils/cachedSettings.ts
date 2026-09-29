import type { AppSettings } from "@shared/contracts";
import { defaultSettings } from "@shared/contracts/app";

import { layoutStorage } from "./layoutStorage";
import { cachedColorTheme, cachedThemePreference } from "./theme";

export function cachedAppSettings(): AppSettings {
  return {
    ...defaultSettings,
    theme: cachedThemePreference(layoutStorage) ?? defaultSettings.theme,
    colorTheme: cachedColorTheme(layoutStorage)
      ?? defaultSettings.colorTheme,
    lightColorTheme: cachedColorTheme(layoutStorage, "light") ?? defaultSettings.colorTheme,
    darkColorTheme: cachedColorTheme(layoutStorage, "dark") ?? defaultSettings.colorTheme,
  };
}
