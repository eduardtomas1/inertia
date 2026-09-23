export const PROJECT_COLOR_NAMES = ["red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;
export const PROJECT_COLOR_EMPHASES = ["icon", "icon-and-name"] as const;

export type ProjectColorName = typeof PROJECT_COLOR_NAMES[number];
export type ProjectColorEmphasis = typeof PROJECT_COLOR_EMPHASES[number];
export type ProjectColor =
  | { kind: "palette"; name: ProjectColorName }
  | { kind: "custom"; value: string };
export type ProjectColorAppearance = "light" | "dark";
export interface ProjectColorTints { light: string; dark: string }

export const PROJECT_COLOR_PALETTE: Readonly<Record<ProjectColorName, ProjectColorTints & { label: string }>> = {
  red: { label: "Red", light: "#a03741", dark: "#e47b80" },
  orange: { label: "Orange", light: "#93460f", dark: "#de844f" },
  amber: { label: "Amber", light: "#72580e", dark: "#c0992a" },
  green: { label: "Green", light: "#1b6a15", dark: "#6db365" },
  teal: { label: "Teal", light: "#116667", dark: "#26b4b4" },
  blue: { label: "Blue", light: "#105ea0", dark: "#5aa3ec" },
  violet: { label: "Violet", light: "#674ba6", dark: "#a58de6" },
  pink: { label: "Pink", light: "#923b7a", dark: "#d37db8" },
};

export const PROJECT_COLOR_EMPHASIS_LABELS: Readonly<Record<ProjectColorEmphasis, string>> = {
  icon: "Icon only",
  "icon-and-name": "Icon and name",
};

export const PROJECT_COLOR_BACKDROPS: Readonly<Record<ProjectColorAppearance, readonly string[]>> = {
  light: ["#d6d6d9", "#d0d9d2", "#ced8dd", "#ded4cf", "#d6d5de"],
  dark: ["#27272a", "#222a23", "#1f292e", "#2e2521", "#27262e"],
};

const HEX_COLOR = /^#[0-9a-f]{6}$/u;

export function normalizeProjectHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const expanded = /^#?[0-9a-f]{3}$/u.test(trimmed)
    ? `#${[...trimmed.replace("#", "")].map((digit) => digit + digit).join("")}`
    : trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return HEX_COLOR.test(expanded) ? expanded : null;
}
