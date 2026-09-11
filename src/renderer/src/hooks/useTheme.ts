import { useLayoutEffect } from "react";
import type { ColorThemeId, ThemePreference } from "@shared/contracts";
import { resolveThemePreference } from "../utils/theme";

export function useTheme(
  preference: ThemePreference,
  colorTheme: ColorThemeId,
  lightColorTheme = colorTheme,
  darkColorTheme = colorTheme,
): void {
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      const resolved = resolveThemePreference(preference, media.matches);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.colorTheme = resolved === "light" ? lightColorTheme : darkColorTheme;
      document.documentElement.style.colorScheme = resolved;
    };

    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [lightColorTheme, darkColorTheme, preference]);
}
