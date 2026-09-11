import type { DatabaseMigrationDefinition } from "./catalog";

export const appearanceThemePairMigration: DatabaseMigrationDefinition = {
  name: "IndependentLightAndDarkThemes",
  up: `
    ALTER TABLE app_state ADD COLUMN light_color_theme TEXT
      CHECK (light_color_theme IS NULL OR light_color_theme IN ('inertia', 'grove', 'ocean', 'ember', 'iris'));
    ALTER TABLE app_state ADD COLUMN dark_color_theme TEXT
      CHECK (dark_color_theme IS NULL OR dark_color_theme IN ('inertia', 'grove', 'ocean', 'ember', 'iris'));
    UPDATE app_state SET light_color_theme = color_theme, dark_color_theme = color_theme;
  `,
};
