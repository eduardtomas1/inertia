import type { ColorThemeId } from "@shared/contracts";

export type ColorThemeOption = Readonly<{
  id: ColorThemeId;
  label: string;
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
  },
  {
    id: "grove",
    label: "Grove",
  },
  {
    id: "ocean",
    label: "Ocean",
  },
  {
    id: "ember",
    label: "Ember",
  },
  {
    id: "iris",
    label: "Iris",
  },
];
