import type { ColorThemeId } from "@shared/contracts";

export type ColorThemePreview = Readonly<{
  canvas: string;
  sidebar: string;
  surface: string;
  accent: string;
  accentSoft: string;
  messageAction: string;
}>;

export type ColorThemeOption = Readonly<{
  id: ColorThemeId;
  label: string;
  description: string;
  light: ColorThemePreview;
  dark: ColorThemePreview;
}>;

/**
 * T3 Code's MIT-licensed built-in theme library inspired the paired preview
 * model. The colors are adapted to Inertia's existing semantic roles and
 * restrained workbench contrast.
 */
export const COLOR_THEME_OPTIONS: readonly ColorThemeOption[] = [
  {
    id: "inertia",
    label: "Inertia",
    description: "Graphite surfaces with a quiet violet signal.",
    light: {
      canvas: "#f1f1f3",
      sidebar: "#ececf0",
      surface: "#fcfcfd",
      accent: "#4239cc",
      accentSoft: "#e2e1fb",
      messageAction: "#6259d9",
    },
    dark: {
      canvas: "#070708",
      sidebar: "#111113",
      surface: "#161618",
      accent: "#a89fff",
      accentSoft: "#232033",
      messageAction: "#c4beff",
    },
  },
  {
    id: "grove",
    label: "Grove",
    description: "Soft botanical greens with warm, grounded depth.",
    light: {
      canvas: "#eef2ed",
      sidebar: "#e7ede5",
      surface: "#fbfcfa",
      accent: "#2f6f4e",
      accentSoft: "#d5e8da",
      messageAction: "#8a6328",
    },
    dark: {
      canvas: "#101713",
      sidebar: "#131d16",
      surface: "#1c281f",
      accent: "#82c99a",
      accentSoft: "#223c2c",
      messageAction: "#d8b66d",
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Cool marine blues with a clear teal current.",
    light: {
      canvas: "#edf3f6",
      sidebar: "#e6eff3",
      surface: "#fcfdfe",
      accent: "#28698a",
      accentSoft: "#d6e9f1",
      messageAction: "#2b7c78",
    },
    dark: {
      canvas: "#0e171d",
      sidebar: "#101d25",
      surface: "#192a34",
      accent: "#78b9d7",
      accentSoft: "#1b3542",
      messageAction: "#73c7c0",
    },
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm clay surfaces with a focused copper spark.",
    light: {
      canvas: "#f5f0ed",
      sidebar: "#f1e9e4",
      surface: "#fffdfb",
      accent: "#a14830",
      accentSoft: "#f0d8ce",
      messageAction: "#b4583d",
    },
    dark: {
      canvas: "#191311",
      sidebar: "#201713",
      surface: "#2c1f1a",
      accent: "#e89a78",
      accentSoft: "#44271d",
      messageAction: "#f0aa8c",
    },
  },
  {
    id: "iris",
    label: "Iris",
    description: "Lavender shadows with a vivid but composed bloom.",
    light: {
      canvas: "#f2f0f7",
      sidebar: "#ece9f3",
      surface: "#fdfcff",
      accent: "#6550ad",
      accentSoft: "#e1daf5",
      messageAction: "#9a4f92",
    },
    dark: {
      canvas: "#12101a",
      sidebar: "#171320",
      surface: "#211c2e",
      accent: "#b49bf0",
      accentSoft: "#30264a",
      messageAction: "#dda0d5",
    },
  },
];
