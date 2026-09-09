const SRGB_FROM_LMS = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.7076147010],
];

function encodeChannel(value) {
  return value <= 0.0031308
    ? 12.92 * value
    : 1.055 * value ** (1 / 2.4) - 0.055;
}

function decodeChannel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function oklchToLinearRgb({ l, c, h }) {
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

function withinGamut(color, epsilon = 1e-4) {
  return oklchToLinearRgb(color)
    .every((channel) => channel >= -epsilon && channel <= 1 + epsilon);
}

export function gamutMapChroma(color) {
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

export function oklchToHex(color) {
  const mapped = gamutMapChroma(color);
  const channels = oklchToLinearRgb(mapped).map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    return Math.round(encodeChannel(clamped) * 255);
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(decodeChannel);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function maxChromaAt(l, h, cap) {
  let low = 0;
  let high = 0.45;
  for (let step = 0; step < 40; step += 1) {
    const mid = (low + high) / 2;
    if (withinGamut({ l, c: mid, h })) low = mid;
    else high = mid;
  }
  return Math.min(low * 0.94, cap);
}

export function solveLightness({ hue, chromaCap, backgrounds, target, direction, startL }) {
  const limit = direction === "darker" ? 0 : 1;
  let low = startL;
  let high = limit;
  const build = (l) => oklchToHex({ l, c: maxChromaAt(l, hue, chromaCap), h: hue });
  const clears = (l) => {
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
