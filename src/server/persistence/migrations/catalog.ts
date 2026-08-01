import type { DatabaseMigration } from "./runner";

export const LEGACY_SCHEMA_MIGRATION_COUNT = 17;
export const CURRENT_DATABASE_SCHEMA_VERSION = 42;

export type DatabaseMigrationDefinition = Omit<DatabaseMigration, "version">;

/**
 * Builds the one authoritative, immutable migration catalog.
 *
 * Keeping numbering here prevents a newly inserted extension from silently
 * renumbering released schema versions. SQL and data-migration callbacks stay
 * in their original order and are never rewritten by this helper.
 */
export function createRuntimeMigrationCatalog(
  legacyDefinitions: readonly DatabaseMigrationDefinition[],
  extensionDefinitions: readonly DatabaseMigrationDefinition[],
): readonly DatabaseMigration[] {
  if (legacyDefinitions.length !== LEGACY_SCHEMA_MIGRATION_COUNT) {
    throw new Error(
      `The legacy schema catalog must contain exactly ${LEGACY_SCHEMA_MIGRATION_COUNT} migrations.`,
    );
  }
  const definitions = [...legacyDefinitions, ...extensionDefinitions];
  if (definitions.length !== CURRENT_DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `The runtime schema catalog must contain exactly ${CURRENT_DATABASE_SCHEMA_VERSION} migrations.`,
    );
  }
  return Object.freeze(definitions.map((definition, index) =>
    Object.freeze({
      version: index + 1,
      ...definition,
    })));
}
