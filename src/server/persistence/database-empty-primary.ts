import Database from "better-sqlite3";

import { regularOwnedFile } from "./database-backup-cancellation";

export function schemaLessEmptyDatabase(path: string): boolean {
  if (!regularOwnedFile(path)) return false;
  let database: Database.Database | null = null;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    const { count } = database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master",
    ).get() as { count: number };
    return count === 0
      && database.pragma("user_version", { simple: true }) === 0
      && database.pragma("application_id", { simple: true }) === 0
      && (database.pragma("page_count", { simple: true }) as number) <= 1;
  } catch {
    return false;
  } finally {
    if (database?.open) database.close();
  }
}
