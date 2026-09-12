export interface OklchColor {
  l: number;
  c: number;
  h: number;
}

export function oklchToLinearRgb(color: OklchColor): number[];
export function gamutMapChroma(color: OklchColor): OklchColor;
export function oklchToHex(color: OklchColor): string;
export function hexToRgb(hex: string): number[];
export function relativeLuminance(hex: string): number;
export function contrastRatio(foreground: string, background: string): number;
export function maxChromaAt(l: number, h: number, cap: number): number;
export function solveLightness(input: {
  hue: number;
  chromaCap: number;
  backgrounds: readonly string[];
  target: number;
  direction: "darker" | "lighter";
  startL: number;
}): { l: number; hex: string };
