import { COLOR_THEME_IDS } from "./app";

const colorTheme = (value: unknown): boolean =>
  value === undefined || (typeof value === "string" && (COLOR_THEME_IDS as readonly string[]).includes(value));
const customColor = (value: unknown): boolean =>
  value == null || (typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value));

export function validAppearanceSettings(value: Record<string, unknown>): boolean {
  return colorTheme(value.lightColorTheme) && colorTheme(value.darkColorTheme)
    && customColor(value.lightCustomColor) && customColor(value.darkCustomColor)
    && (value.mutedCustomColors === undefined || typeof value.mutedCustomColors === "boolean");
}
