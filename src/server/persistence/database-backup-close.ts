import type Database from "better-sqlite3";
import type { DatabaseBackupManager } from "./database-recovery";

export async function closeDatabaseAfterBackupCancellation(
  database: Database.Database,
  backups: Pick<DatabaseBackupManager, "cancelAndWait">,
  compaction?: { cancelAndWait(): Promise<void> },
): Promise<void> {
  let cancellationError: unknown;
  try {
    await compaction?.cancelAndWait();
  } catch (error) {
    cancellationError = error;
  }
  try {
    await backups.cancelAndWait();
  } catch (error) {
    cancellationError ??= error;
  } finally {
    if (database.open) database.close();
  }
  if (cancellationError !== undefined) throw cancellationError;
}
