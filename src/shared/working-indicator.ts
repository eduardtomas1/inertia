export const ORB_DESIGNS = [
  "working",
  "searching",
  "solving",
  "listening",
  "connecting",
  "weaving",
  "composing",
  "breathing",
  "shaping",
] as const;

export type OrbDesign = typeof ORB_DESIGNS[number];

export const WORKING_INDICATOR_STYLES = ["classic", "automatic", ...ORB_DESIGNS] as const;

export type WorkingIndicatorStyle = typeof WORKING_INDICATOR_STYLES[number];

export const WORKING_INDICATOR_COLORS = [
  "ink",
  "accent",
  "lilac",
  "sky",
  "mint",
  "amber",
  "rose",
  "custom",
] as const;

export type WorkingIndicatorColor = typeof WORKING_INDICATOR_COLORS[number];

export const WORKING_INDICATOR_SPEEDS = ["calm", "normal", "lively"] as const;

export type WorkingIndicatorSpeed = typeof WORKING_INDICATOR_SPEEDS[number];

export interface WorkingIndicatorSettings {
  style: WorkingIndicatorStyle;
  color: WorkingIndicatorColor;
  customColor: string;
  glow: boolean;
  activity: boolean;
  speed: WorkingIndicatorSpeed;
}

export const DEFAULT_WORKING_INDICATOR: Readonly<WorkingIndicatorSettings> = Object.freeze({
  style: "classic",
  color: "ink",
  customColor: "#ff5fd2",
  glow: false,
  activity: true,
  speed: "normal",
});

export const WORKING_INDICATOR_JSON_MAX_LENGTH = 512;

const WORKING_INDICATOR_KEYS = Object.keys(DEFAULT_WORKING_INDICATOR).sort().join("\0");
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const CANONICAL_HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/u;

function member<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) return null;
  const digits = trimmed.slice(1).toLowerCase();
  return `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits}`;
}

export function parseWorkingIndicatorSettings(value: unknown): WorkingIndicatorSettings {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    style: member(WORKING_INDICATOR_STYLES, record.style) ? record.style : DEFAULT_WORKING_INDICATOR.style,
    color: member(WORKING_INDICATOR_COLORS, record.color) ? record.color : DEFAULT_WORKING_INDICATOR.color,
    customColor: normalizeHexColor(record.customColor) ?? DEFAULT_WORKING_INDICATOR.customColor,
    glow: typeof record.glow === "boolean" ? record.glow : DEFAULT_WORKING_INDICATOR.glow,
    activity: typeof record.activity === "boolean" ? record.activity : DEFAULT_WORKING_INDICATOR.activity,
    speed: member(WORKING_INDICATOR_SPEEDS, record.speed) ? record.speed : DEFAULT_WORKING_INDICATOR.speed,
  };
}

export function parseWorkingIndicatorJson(value: unknown): WorkingIndicatorSettings {
  if (typeof value !== "string" || value.length > WORKING_INDICATOR_JSON_MAX_LENGTH) {
    return parseWorkingIndicatorSettings(null);
  }
  try {
    return parseWorkingIndicatorSettings(JSON.parse(value));
  } catch {
    return parseWorkingIndicatorSettings(null);
  }
}

export function isWorkingIndicatorSettings(value: unknown): value is WorkingIndicatorSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join("\0") === WORKING_INDICATOR_KEYS
    && member(WORKING_INDICATOR_STYLES, record.style)
    && member(WORKING_INDICATOR_COLORS, record.color)
    && typeof record.customColor === "string"
    && CANONICAL_HEX_COLOR_PATTERN.test(record.customColor)
    && typeof record.glow === "boolean"
    && typeof record.activity === "boolean"
    && member(WORKING_INDICATOR_SPEEDS, record.speed);
}
