export interface OklchColor { l: number; c: number; h: number }

const SRGB_FROM_LMS = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.7076147010],
];

function encodeChannel(value: number): number {
  return value <= 0.0031308
    ? 12.92 * value
    : 1.055 * value ** (1 / 2.4) - 0.055;
}

function decodeChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function oklchToLinearRgb({ l, c, h }: OklchColor): number[] {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.2914855480 * b) ** 3,
  ];
  return SRGB_FROM_LMS.map((row) =>
    row[0] * lms[0] + row[1] * lms[1] + row[2] * lms[2]);
}

function withinGamut(color: OklchColor, epsilon = 1e-4): boolean {
  return oklchToLinearRgb(color)
    .every((channel) => channel >= -epsilon && channel <= 1 + epsilon);
}

export function gamutMapChroma(color: OklchColor): OklchColor {
  if (withinGamut(color)) return color;
  let low = 0;
  let high = color.c;
  for (let step = 0; step < 48; step += 1) {
    const mid = (low + high) / 2;
    if (withinGamut({ ...color, c: mid })) low = mid;
    else high = mid;
  }
  return { ...color, c: low };
}

export function oklchToHex(color: OklchColor): string {
  const mapped = gamutMapChroma(color);
  const channels = oklchToLinearRgb(mapped).map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    return Math.round(encodeChannel(clamped) * 255);
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgb(hex: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(decodeChannel);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function maxChromaAt(l: number, h: number, cap: number): number {
  let low = 0;
  let high = 0.45;
  for (let step = 0; step < 40; step += 1) {
    const mid = (low + high) / 2;
    if (withinGamut({ l, c: mid, h })) low = mid;
    else high = mid;
  }
  return Math.min(low * 0.94, cap);
}

export function solveLightness({ hue, chromaCap, backgrounds, target, direction, startL }: { hue: number; chromaCap: number; backgrounds: readonly string[]; target: number; direction: "darker" | "lighter"; startL: number }): { l: number; hex: string } {
  const limit = direction === "darker" ? 0 : 1;
  let low = startL;
  let high = limit;
  const build = (l: number) => oklchToHex({ l, c: maxChromaAt(l, hue, chromaCap), h: hue });
  const clears = (l: number) => {
    const hex = build(l);
    return backgrounds.every((background) => contrastRatio(hex, background) >= target);
  };
  if (clears(startL)) return { l: startL, hex: build(startL) };
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (clears(mid)) high = mid;
    else low = mid;
  }
  return { l: high, hex: build(high) };
}

export function hexToOklch(hex: string): OklchColor {
  const [r, g, b] = hexToRgb(hex).map(decodeChannel);
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
