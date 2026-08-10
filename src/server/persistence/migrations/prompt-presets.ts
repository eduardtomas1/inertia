import type { DatabaseMigrationDefinition } from "./catalog";

/**
 * Kept as one append-only definition so its final catalog position can be
 * assigned only after the coordinating schema work lands.
 */
export const promptPresetMigrationDefinition: DatabaseMigrationDefinition = {
  name: "PersistPromptPresets",
  up: `
    CREATE TABLE IF NOT EXISTS prompt_presets (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      name TEXT NOT NULL
        CHECK (
          length(name) BETWEEN 1 AND 80
          AND trim(name) <> ''
          AND instr(name, char(0)) = 0
          AND instr(name, char(10)) = 0
          AND instr(name, char(13)) = 0
        ),
      body TEXT NOT NULL
        CHECK (
          length(body) BETWEEN 1 AND 20000
          AND trim(body) <> ''
          AND instr(body, char(0)) = 0
        ),
      route_json TEXT
        CHECK (
          route_json IS NULL
          OR (
            length(route_json) BETWEEN 1 AND 1024
            AND json_valid(route_json)
            AND json_type(route_json) = 'object'
          )
        ),
      position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 29),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
      updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
    );
    CREATE INDEX IF NOT EXISTS prompt_presets_position_idx
      ON prompt_presets(position ASC, id ASC);
    CREATE TRIGGER IF NOT EXISTS prompt_presets_count_limit
      BEFORE INSERT ON prompt_presets
      WHEN (SELECT COUNT(*) FROM prompt_presets) >= 30
      BEGIN
        SELECT RAISE(ABORT, 'prompt preset count limit exceeded');
      END;
  `,
};
