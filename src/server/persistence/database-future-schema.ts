import Database from "better-sqlite3";

import { regularOwnedFile } from "./database-backup-cancellation";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "./migrations/catalog";

export function isUnsupportedFutureDatabase(path: string): boolean {
  if (!regularOwnedFile(path)) return false;
  let database: Database.Database | null = null;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    const hasMigrations = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get();
    if (!hasMigrations) return false;
    const versions = database.prepare(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    ).all() as Array<{ version: unknown }>;
    return versions.length > CURRENT_DATABASE_SCHEMA_VERSION
      && versions.every(({ version }, index) =>
        typeof version === "number"
        && Number.isSafeInteger(version)
        && version === index + 1);
  } catch {
    return false;
  } finally {
    if (database?.open) database.close();
  }
}
