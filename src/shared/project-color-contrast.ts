import { PROJECT_COLOR_BACKDROPS, type ProjectColorAppearance } from "./project-colors";

export const PROJECT_COLOR_CONTRAST_TARGET = 4.6;
const CUSTOM_CHROMA_CAP = 0.15;

type Oklch = { l: number; c: number; h: number };

function decode(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encode(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function linearRgb({ l, c, h }: Oklch): [number, number, number] {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.2914855480 * b) ** 3,
  ] as const;
  return [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.7076147010 * lms[2],
  ];
}

function inGamut(color: Oklch): boolean {
  return linearRgb(color).every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
}

function oklchToHex(color: Oklch): string {
  let low = 0;
  let high = color.c;
  if (!inGamut(color)) {
    for (let step = 0; step < 32; step += 1) {
      const mid = (low + high) / 2;
      if (inGamut({ ...color, c: mid })) low = mid;
      else high = mid;
    }
  } else low = color.c;
  return `#${linearRgb({ ...color, c: low })
    .map((channel) => Math.round(encode(Math.min(1, Math.max(0, channel))) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function hexToOklch(hex: string): Oklch {
  const [r, g, b] = channels(hex).map(decode) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return {
    l: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    c: Math.hypot(a, bb),
    h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
  };
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(decode) as [number, number, number];
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function adaptProjectColor(hex: string, appearance: ProjectColorAppearance): string {
  const source = hexToOklch(hex);
  const chroma = Math.min(source.c, CUSTOM_CHROMA_CAP);
  const backdrops = PROJECT_COLOR_BACKDROPS[appearance];
  const build = (l: number): string => oklchToHex({ l, c: chroma, h: source.h });
  const clears = (l: number): boolean => backdrops.every((backdrop) => contrastRatio(build(l), backdrop) >= PROJECT_COLOR_CONTRAST_TARGET);
  if (clears(source.l)) return build(source.l);
  let low = source.l;
  let high = appearance === "dark" ? 1 : 0;
  for (let step = 0; step < 28; step += 1) {
    const mid = (low + high) / 2;
    if (clears(mid)) high = mid;
    else low = mid;
  }
  return build(high);
}
