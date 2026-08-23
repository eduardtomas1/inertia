import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

const FILE_MODE = 0o600;
const DATABASE_FAMILY_SUFFIXES = ["", "-wal", "-shm"] as const;

export function databaseFamilyEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function availableDatabaseFamilyStem(directory: string, stem: string): string {
  for (let index = 0; ; index += 1) {
    const candidate = `${stem}${index === 0 ? "" : `-${index}`}`;
    if (DATABASE_FAMILY_SUFFIXES.every((suffix) => !databaseFamilyEntryExists(
      join(directory, `${candidate}.sqlite${suffix}`),
    ))) return candidate;
  }
}

/** Moves one database family as a unit or rolls every completed move back. */
export function quarantineDatabaseFamily(
  databasePath: string,
  corruptDirectory: string,
  quarantineStem: string,
): {
  preservedCorruptPrimary: boolean;
  preservedDatabaseFamilyMembers: number;
} {
  const targetStem = availableDatabaseFamilyStem(
    corruptDirectory,
    quarantineStem,
  );
  const moves = DATABASE_FAMILY_SUFFIXES.flatMap((suffix) => {
    const source = `${databasePath}${suffix}`;
    if (!databaseFamilyEntryExists(source)) return [];
    const metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("The database recovery source is not a local file.");
    }
    return [{
      metadata,
      source,
      target: join(corruptDirectory, `${targetStem}.sqlite${suffix}`),
      suffix,
    }];
  });
  const completed: typeof moves = [];
  try {
    for (const move of moves) {
      renameSync(move.source, move.target);
      completed.push(move);
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      const descriptor = openSync(move.target, constants.O_RDONLY | noFollow);
      try {
        const moved = fstatSync(descriptor);
        if (
          !moved.isFile()
          || moved.dev !== move.metadata.dev
          || moved.ino !== move.metadata.ino
          || moved.size !== move.metadata.size
          || moved.mtimeMs !== move.metadata.mtimeMs
        ) throw new Error("The database recovery source changed during quarantine.");
        fchmodSync(descriptor, FILE_MODE);
      } finally {
        closeSync(descriptor);
      }
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const move of completed.reverse()) {
      try {
        renameSync(move.target, move.source);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "The database recovery quarantine transaction could not be rolled back; moved evidence was left in place.",
      );
    }
    throw error;
  }
  return {
    preservedCorruptPrimary: moves.some(({ suffix }) => suffix === ""),
    preservedDatabaseFamilyMembers: moves.length,
  };
}
