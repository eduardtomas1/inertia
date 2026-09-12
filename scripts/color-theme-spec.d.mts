export type PaletteFamily = "inertia" | "grove" | "ocean" | "ember" | "iris";
export type PaletteAppearance = "light" | "dark";

export const PALETTE_FAMILIES: readonly PaletteFamily[];
export const PALETTE_APPEARANCES: readonly PaletteAppearance[];
export const BASE_NEUTRAL_CHROMA: Readonly<Record<PaletteAppearance, number>>;
export const SEMANTIC_HUES: Readonly<Record<string, number>>;
export const ARCHITECTURE: Readonly<Record<PaletteAppearance, {
  ladder: Readonly<Record<string, number>>;
  direction: "darker" | "lighter";
  accentL: number;
  accentChroma: number;
  [key: string]: unknown;
}>>;
export const FAMILY_SPECS: Readonly<Record<PaletteFamily, {
  neutralHue: number;
  accentHue: number;
  neutralTint: number;
}>>;

export function buildPaletteTokens(
  family: PaletteFamily,
  appearance: PaletteAppearance,
): (readonly [string, string])[];
