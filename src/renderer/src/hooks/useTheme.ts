import { useLayoutEffect } from "react";
import type { AppSettings } from "@shared/contracts";
import type { buildCustomPaletteTokens } from "@shared/theme/color-theme-spec";
import { resolveThemePreference, type ResolvedTheme } from "../utils/theme";
import { applyCustomPalette, cacheCustomColor, cachedCustomColor, cachedCustomPalette, isCustomColor, type PaletteTokens } from "../utils/customTheme";
import { layoutStorage } from "../utils/layoutStorage";

let paletteBuilder: typeof buildCustomPaletteTokens | undefined;

export function useTheme({
  theme: preference, colorTheme, lightColorTheme = colorTheme, darkColorTheme = colorTheme,
  lightCustomColor, darkCustomColor,
}: Pick<AppSettings, "theme" | "colorTheme" | "lightColorTheme" | "darkColorTheme" | "lightCustomColor" | "darkCustomColor">): void {
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let cancelled = false;
    const palettes: Record<ResolvedTheme, PaletteTokens | null> = { light: null, dark: null };
    const loadPalettes = () => {
      for (const [mode, color] of [["light", lightCustomColor], ["dark", darkCustomColor]] as const) {
        palettes[mode] = paletteBuilder && isCustomColor(color) ? paletteBuilder(color, mode)
          : cachedCustomPalette(layoutStorage, color && cachedCustomColor(layoutStorage, mode), mode);
        if (paletteBuilder || !color) cacheCustomColor(layoutStorage, color, mode, palettes[mode] ?? []);
      }
    };
    const applyTheme = () => {
      const resolved = resolveThemePreference(preference, media.matches);
      const root = document.documentElement;
      root.dataset.theme = resolved;
      root.dataset.colorTheme = palettes[resolved] ? "custom" : resolved === "light" ? lightColorTheme : darkColorTheme;
      applyCustomPalette(palettes[resolved]);
      root.style.colorScheme = resolved;
    };

    loadPalettes();
    applyTheme();
    if (!paletteBuilder && (lightCustomColor || darkCustomColor)) {
      void import("@shared/theme/color-theme-spec").then(({ buildCustomPaletteTokens }) => {
        paletteBuilder = buildCustomPaletteTokens;
        if (cancelled) return;
        loadPalettes();
        applyTheme();
      }).catch(() => undefined);
    }
    media.addEventListener("change", applyTheme);
    return () => { cancelled = true; media.removeEventListener("change", applyTheme); };
  }, [lightColorTheme, darkColorTheme, preference, lightCustomColor, darkCustomColor]);
}
