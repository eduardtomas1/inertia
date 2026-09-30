import type { DatabaseMigrationDefinition } from "./catalog";

export const customAppearanceColorsMigration: DatabaseMigrationDefinition = {
  name: "CustomAppearanceColors",
  up: (database) => {
    const columns = database.prepare("PRAGMA table_info(app_state)")
      .all() as Array<{ name: string }>;
    const statements = [
      ["light_custom_color", `
        ALTER TABLE app_state ADD COLUMN light_custom_color TEXT
          CHECK (light_custom_color IS NULL OR (length(light_custom_color) = 7
            AND substr(light_custom_color, 1, 1) = '#'
            AND substr(light_custom_color, 2) NOT GLOB '*[^0-9a-fA-F]*'));
      `],
      ["dark_custom_color", `
        ALTER TABLE app_state ADD COLUMN dark_custom_color TEXT
          CHECK (dark_custom_color IS NULL OR (length(dark_custom_color) = 7
            AND substr(dark_custom_color, 1, 1) = '#'
            AND substr(dark_custom_color, 2) NOT GLOB '*[^0-9a-fA-F]*'));
      `],
    ] as const;
    for (const [column, statement] of statements) {
      if (!columns.some(({ name }) => name === column)) database.exec(statement);
    }
  },
};
