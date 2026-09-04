import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

import {
  removeIfRegularFile,
  removeInterruptedDatabaseFileFamily,
} from "./database-backup-cancellation";

function safeDatabaseStem(databasePath: string): string {
  const raw = basename(databasePath, extname(databasePath));
  return /^[A-Za-z0-9_-]{1,80}$/u.test(raw) ? raw : "inertia";
}

function escapedRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function backupFamilyPattern(
  databasePath: string,
  kind: "partial" | "partial-sidecar" | "complete-sidecar",
): RegExp {
  const partial = kind === "partial" || kind === "partial-sidecar";
  const sidecar = kind !== "partial";
  return new RegExp(
    `^${escapedRegularExpression(safeDatabaseStem(databasePath))}-[0-9TZ]+(?:-[0-9]+)?\\.sqlite${partial ? "\\.partial" : ""}${sidecar ? "-(?:wal|shm)" : ""}$`,
    "u",
  );
}

function sidecarDatabasePath(path: string): string {
  return path.replace(/-(?:wal|shm)$/u, "");
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function removeRegularDatabaseSidecars(path: string): void {
  removeIfRegularFile(`${path}-wal`);
  removeIfRegularFile(`${path}-shm`);
}

/**
 * Removes only filename-constrained regular files in the automatic backup
 * directory. Symlinks, directories, near-match names, and retained complete
 * backup families remain fail-closed.
 */
export function cleanAutomaticBackupSidecars(
  databasePath: string,
  backupsDirectory: string,
): void {
  if (!existsSync(backupsDirectory)) return;
  const partialPattern = backupFamilyPattern(databasePath, "partial");
  const partialSidecarPattern = backupFamilyPattern(
    databasePath,
    "partial-sidecar",
  );
  const completeSidecarPattern = backupFamilyPattern(
    databasePath,
    "complete-sidecar",
  );
  for (const filename of readdirSync(backupsDirectory)) {
    if (partialPattern.test(filename)) {
      removeInterruptedDatabaseFileFamily(join(backupsDirectory, filename));
      continue;
    }
    if (partialSidecarPattern.test(filename)) {
      removeInterruptedDatabaseFileFamily(sidecarDatabasePath(join(
        backupsDirectory,
        filename,
      )));
      continue;
    }
    if (completeSidecarPattern.test(filename)) {
      const completePath = sidecarDatabasePath(join(
        backupsDirectory,
        filename,
      ));
      if (!pathEntryExists(completePath)) {
        // Never include the absent base in this sweep: if another process
        // creates it after the lstat, only the historical sidecars are ours.
        removeRegularDatabaseSidecars(completePath);
      }
    }
  }
}
