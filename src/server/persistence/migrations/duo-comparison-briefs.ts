import type { DatabaseMigrationDefinition } from "./catalog";

export const DUO_COMPARISON_BRIEFS_SCHEMA_VERSION = 106;

export const duoComparisonBriefsMigration: DatabaseMigrationDefinition = {
  name: "PersistDuoComparisonBriefs",
  up: `
    ALTER TABLE messages ADD COLUMN duo_comparison_json TEXT
      CHECK (duo_comparison_json IS NULL OR (
        role = 'user' AND json_valid(duo_comparison_json)
        AND json_type(duo_comparison_json) = 'object'
        AND length(CAST(duo_comparison_json AS BLOB)) <= 4096
      ));
  `,
};
