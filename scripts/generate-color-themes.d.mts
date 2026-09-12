import type { PaletteAppearance, PaletteFamily } from "./color-theme-spec.d.mts";

export function paletteSelector(
  family: PaletteFamily,
  appearance: PaletteAppearance,
): string;
export function swatchSelector(
  family: PaletteFamily,
  appearance: PaletteAppearance,
): string;
export function buildSwatchTokens(
  family: PaletteFamily,
  appearance: PaletteAppearance,
): (readonly [string, string])[];
export function renderFiles(
  read: (path: string) => string,
): Record<string, string>;
export function windowBackground(appearance: PaletteAppearance): string;
