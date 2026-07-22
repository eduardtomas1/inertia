import { useLayoutEffect } from "react";
import type { ThemePreference } from "@shared/contracts";

export function useTheme(preference: ThemePreference): void {
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };

    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [preference]);
}
