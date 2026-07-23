import { useLayoutEffect } from "react";
import type { ThemePreference } from "@shared/contracts";
import { resolveThemePreference } from "../utils/theme";

export function useTheme(preference: ThemePreference): void {
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      const resolved = resolveThemePreference(preference, media.matches);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };

    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [preference]);
}
