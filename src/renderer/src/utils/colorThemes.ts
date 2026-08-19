import type { ColorThemeId } from "@shared/contracts";

export type ColorThemeOption = Readonly<{
  id: ColorThemeId;
  label: string;
  description: string;
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
  },
  {
    id: "grove",
    label: "Grove",
    description: "Soft botanical greens with warm, grounded depth.",
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Cool marine blues with a clear teal current.",
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm clay surfaces with a focused copper spark.",
  },
  {
    id: "iris",
    label: "Iris",
    description: "Lavender shadows with a vivid but composed bloom.",
  },
];
