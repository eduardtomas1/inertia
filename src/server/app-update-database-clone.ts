import { lstatSync, realpathSync, statfsSync } from "node:fs";

import Database from "better-sqlite3";

import {
  CandidateViabilityError,
  type AppUpdateCandidateViabilityRequest,
} from "../node/app-update-candidate-viability-protocol.js";
import {
  createAppUpdateCloneFile,
  validateAppUpdateScratch,
} from "../node/app-update-validation-scratch.js";

const MAX_DISK_CLONE_BYTES = 4 * 1_024 * 1_024 * 1_024;
const SQLITE_CACHE_KIB = 8 * 1_024;
const RESOURCE_ERRORS = new Set([
  "ENOSPC", "EDQUOT", "ENOMEM", "SQLITE_FULL", "SQLITE_NOMEM",
]);

export function candidateDatabaseError(error: unknown): CandidateViabilityError {
  if (error instanceof CandidateViabilityError) return error;
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth += 1) {
    if ("code" in cause && typeof cause.code === "string" && RESOURCE_ERRORS.has(cause.code)) {
      return new CandidateViabilityError("validation-resource-limit");
    }
    cause = "cause" in cause ? cause.cause : null;
  }
  return new CandidateViabilityError("database-incompatible");
}

/** Back up the reader's existing transaction, including its committed WAL view. */
export async function diskAppUpdateDatabaseClone(
  database: Database.Database,
  request: AppUpdateCandidateViabilityRequest,
  expectedBytes: number,
): Promise<Database.Database> {
  const scratch = request.scratch;
  if (
    !scratch
    || !Number.isSafeInteger(expectedBytes)
    || expectedBytes < 1
    || expectedBytes > MAX_DISK_CLONE_BYTES
  ) throw new CandidateViabilityError("validation-resource-limit");
  let clone: Database.Database | null = null;
  try {
    validateAppUpdateScratch(scratch, request.operationId);
    const space = statfsSync(scratch.directory, { bigint: true });
    // Allow a second image for migration growth and a rollback journal. SQLite
    // still reports a distinct resource failure if other writers consume space.
    if (space.bavail * space.bsize < BigInt(expectedBytes) * 3n + 64n * 1_024n * 1_024n) {
      throw new CandidateViabilityError("validation-resource-limit");
    }
    const path = createAppUpdateCloneFile(scratch, request.operationId);
    const named = lstatSync(path, { bigint: true });
    await database.backup(path, {
      progress: () => {
        validateAppUpdateScratch(scratch, request.operationId);
        return 1_024;
      },
    });
    validateAppUpdateScratch(scratch, request.operationId);
    const actual = lstatSync(path, { bigint: true });
    if (
      actual.isSymbolicLink()
      || !actual.isFile()
      || named.dev !== actual.dev
      || named.ino !== actual.ino
      || actual.size !== BigInt(expectedBytes)
      || realpathSync(path) !== path
    ) throw new CandidateViabilityError("invalid-request");
    clone = new Database(path, { fileMustExist: true });
    clone.pragma(`cache_size = -${SQLITE_CACHE_KIB}`);
    clone.pragma("mmap_size = 0");
    // Keep journals in the same private directory. Avoid a second large WAL.
    clone.pragma("journal_mode = DELETE");
    clone.pragma("temp_store = MEMORY");
    const pageSize = clone.pragma("page_size", { simple: true });
    if (typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new CandidateViabilityError("database-incompatible");
    }
    const maximumPages = Math.floor(Math.min(MAX_DISK_CLONE_BYTES, expectedBytes * 2) / pageSize);
    if (clone.pragma(`max_page_count = ${maximumPages}`, { simple: true }) !== maximumPages) {
      throw new CandidateViabilityError("validation-resource-limit");
    }
    return clone;
  } catch (error) {
    clone?.close();
    throw candidateDatabaseError(error);
  }
}
