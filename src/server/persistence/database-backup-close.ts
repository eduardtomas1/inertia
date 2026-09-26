import type Database from "better-sqlite3";
import type { DatabaseBackupManager } from "./database-recovery";

export async function closeDatabaseAfterBackupCancellation(
  database: Database.Database,
  backups: Pick<DatabaseBackupManager, "cancelAndWait">,
): Promise<void> {
  let backupError: unknown;
  try {
    // Shutdown owns a 2.5s process-wide deadline. Do not begin a full online
    // backup here; rely on the hourly validated rotation plus WAL recovery.
    await backups.cancelAndWait();
  } catch (error) {
    backupError = error;
  } finally {
    if (database.open) database.close();
  }
  if (backupError !== undefined) throw backupError;
}
