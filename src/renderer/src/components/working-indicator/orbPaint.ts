import type { OrbFrame } from "../../vendor/thinking-orbs";

export type Rgb = readonly [number, number, number];

const DARK_BASE: Rgb = [24, 24, 28];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

export const SMALL_ORB_CONTRAST_LIFT = 0.35;
export const SMALL_ORB_MAX_SIZE = 24;

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function contrastLiftForSize(size: number): number {
  return size < SMALL_ORB_MAX_SIZE ? SMALL_ORB_CONTRAST_LIFT : 0;
}

export function inkFor(white: number, dark: boolean, rgb: Rgb | null, lift: number): Rgb {
  const w = Math.min(1, Math.max(0, white));
  let b = dark ? 1 - w : w;
  if (dark && lift) b = lift + (1 - lift) * b;
  if (!dark && lift) b = b * (1 - lift);
  if (!rgb) {
    const g = Math.round(b * 255);
    return [g, g, g];
  }
  if (dark) {
    const base = mix(DARK_BASE, rgb, Math.min(1, 0.45 + b * 0.8));
    return b > 0.72 ? mix(base, WHITE, Math.min(0.38, (b - 0.72) * 1.3)) : base;
  }
  const d = 1 - b;
  return mix(mix(rgb, WHITE, 0.25), mix(rgb, BLACK, 0.4), Math.min(1, 0.4 + d * 1.2));
}

export function parseCssRgb(value: string | null | undefined): Rgb | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/u.exec(text)?.[1];
  if (hex) {
    const digits = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const packed = Number.parseInt(digits, 16);
    return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
  }
  const channels = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/u.exec(text);
  if (!channels) return null;
  const rgb = [channels[1], channels[2], channels[3]].map(Number);
  if (rgb.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) return null;
  return [rgb[0]!, rgb[1]!, rgb[2]!];
}

export const ORB_BLEED_RATIO = 0.35;

export interface OrbGlow {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  canvas: CanvasImageSource;
  rgb: Rgb;
  blur: number;
  alpha: number;
  scale: number;
}

export function orbBleed(size: number): number {
  return size * ORB_BLEED_RATIO;
}

export function orbGlowStyle(rgb: Rgb, dark: boolean, size: number): { rgb: Rgb; sigma: number; alpha: number } {
  const small = size < SMALL_ORB_MAX_SIZE;
  if (dark) {
    return { rgb: mix(rgb, WHITE, 0.18), sigma: size * (small ? 0.07 : 0.09), alpha: small ? 0.55 : 0.8 };
  }
  return { rgb: mix(rgb, BLACK, 0.08), sigma: size * (small ? 0.045 : 0.055), alpha: small ? 0.4 : 0.55 };
}

export const ORB_INK_STEPS = 128;

function rgbStyle(rgb: Rgb): string {
  return `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`;
}

export function orbInkPalette(dark: boolean, rgb: Rgb | null, lift: number): string[] {
  return Array.from({ length: ORB_INK_STEPS + 1 }, (_, step) =>
    rgbStyle(inkFor(step / ORB_INK_STEPS, dark, rgb, lift)));
}

function inkStep(white: number): number {
  return Math.round(Math.min(1, Math.max(0, white)) * ORB_INK_STEPS);
}

export interface OrbPaintLayer {
  frame: OrbFrame;
  alpha: number;
}

export function paintOrbLayers(
  context: CanvasRenderingContext2D,
  layers: readonly OrbPaintLayer[],
  options: {
    scale: number;
    offset: number;
    width: number;
    height: number;
    palette: readonly string[];
    glow?: OrbGlow | null;
  },
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.clearRect(0, 0, options.width, options.height);
  const glow = options.glow;
  if (glow) {
    const layer = glow.context;
    const reduction = glow.scale;
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalAlpha = 1;
    layer.clearRect(0, 0, options.width, options.height);
    layer.setTransform(options.scale * reduction, 0, 0, options.scale * reduction, options.offset * reduction, options.offset * reduction);
    layer.fillStyle = rgbStyle(glow.rgb);
    layer.strokeStyle = layer.fillStyle;
    for (const { frame, alpha } of layers) {
      if (alpha <= 0) continue;
      const layerAlpha = Math.min(1, alpha);
      for (const line of frame.lines) {
        layer.globalAlpha = layerAlpha * (line.a ?? 1) * (1 - Math.min(1, Math.max(0, line.white)));
        layer.lineWidth = line.w * 1.5;
        layer.beginPath();
        layer.moveTo(line.x1, line.y1);
        layer.lineTo(line.x2, line.y2);
        layer.stroke();
      }
      for (const dot of frame.dots) {
        const nearness = 1 - Math.min(1, Math.max(0, dot.white));
        layer.globalAlpha = layerAlpha * (dot.a ?? 1) * (0.25 + 0.75 * nearness);
        layer.beginPath();
        layer.arc(dot.x, dot.y, dot.r * 1.4, 0, Math.PI * 2);
        layer.fill();
      }
    }
    layer.globalAlpha = 1;
    context.filter = `blur(${glow.blur}px)`;
    context.globalAlpha = glow.alpha;
    context.drawImage(glow.canvas, 0, 0, options.width, options.height);
    context.filter = "none";
    context.globalAlpha = 1;
  }
  context.setTransform(options.scale, 0, 0, options.scale, options.offset, options.offset);
  const palette = options.palette;
  for (const { frame, alpha } of layers) {
    if (alpha <= 0) continue;
    const layerAlpha = Math.min(1, alpha);
    for (const line of frame.lines) {
      context.globalAlpha = layerAlpha * (line.a ?? 1);
      context.strokeStyle = palette[inkStep(line.white)]!;
      context.lineWidth = line.w;
      context.beginPath();
      context.moveTo(line.x1, line.y1);
      context.lineTo(line.x2, line.y2);
      context.stroke();
    }
    for (const dot of frame.dots) {
      context.globalAlpha = layerAlpha * (dot.a ?? 1);
      context.fillStyle = palette[inkStep(dot.white)]!;
      context.beginPath();
      context.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
      context.fill();
    }
  }
  context.globalAlpha = 1;
}
