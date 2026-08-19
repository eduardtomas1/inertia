import type { DatabaseMigrationDefinition } from "./catalog";

export const persistColorTheme: DatabaseMigrationDefinition = {
  name: "PersistColorTheme",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "color_theme")) return;
    database.exec(`
      ALTER TABLE app_state
        ADD COLUMN color_theme TEXT NOT NULL DEFAULT 'inertia'
        CHECK (color_theme IN ('inertia', 'grove', 'ocean', 'ember', 'iris'));
    `);
  },
};
