import { useLayoutEffect } from "react";
import type { AppSettings } from "@shared/contracts";
import { resolveThemePreference } from "../utils/theme";
import { applyCustomPalette, cacheCustomColor, cachedCustomPalette, isCustomColor } from "../utils/customTheme";
import { layoutStorage } from "../utils/layoutStorage";

export function useTheme({
  theme: preference, colorTheme, lightColorTheme = colorTheme, darkColorTheme = colorTheme,
  lightCustomColor, darkCustomColor,
}: Pick<AppSettings, "theme" | "colorTheme" | "lightColorTheme" | "darkColorTheme" | "lightCustomColor" | "darkCustomColor">): void {
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let cancelled = false;
    const palettes = {
      light: cachedCustomPalette(layoutStorage, lightCustomColor, "light"),
      dark: cachedCustomPalette(layoutStorage, darkCustomColor, "dark"),
    };
    if (!lightCustomColor) cacheCustomColor(layoutStorage, null, "light");
    if (!darkCustomColor) cacheCustomColor(layoutStorage, null, "dark");
    const applyTheme = () => {
      const resolved = resolveThemePreference(preference, media.matches);
      const root = document.documentElement;
      root.dataset.theme = resolved;
      root.dataset.colorTheme = palettes[resolved] ? "custom" : resolved === "light" ? lightColorTheme : darkColorTheme;
      applyCustomPalette(palettes[resolved]);
      root.style.colorScheme = resolved;
    };

    applyTheme();
    if (lightCustomColor || darkCustomColor) {
      // Preset users need no palette generator in either window's startup bundle.
      void import("@shared/theme/color-theme-spec").then(({ buildCustomPaletteTokens }) => {
        if (cancelled) return;
        for (const [mode, color] of [["light", lightCustomColor], ["dark", darkCustomColor]] as const) {
          palettes[mode] = isCustomColor(color) ? buildCustomPaletteTokens(color, mode) : null;
          cacheCustomColor(layoutStorage, color, mode, palettes[mode] ?? []);
        }
        applyTheme();
      }).catch(() => { /* Keep the cached palette or preset if loading is unavailable. */ });
    }
    media.addEventListener("change", applyTheme);
    return () => { cancelled = true; media.removeEventListener("change", applyTheme); };
  }, [lightColorTheme, darkColorTheme, preference, lightCustomColor, darkCustomColor]);
}
