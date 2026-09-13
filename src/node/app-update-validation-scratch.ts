import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  CandidateViabilityError,
  type AppUpdateValidationScratch,
} from "./app-update-candidate-viability-protocol.js";

const CLONE_NAME = "candidate.sqlite";
const CLONE_FILES = new Set([
  CLONE_NAME, `${CLONE_NAME}-wal`, `${CLONE_NAME}-shm`, `${CLONE_NAME}-journal`,
]);

function prefix(operationId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) {
    throw new CandidateViabilityError("invalid-request");
  }
  return `inertia-update-validation-${operationId}-`;
}

export function validateAppUpdateScratch(
  scratch: AppUpdateValidationScratch,
  operationId: string,
): void {
  const metadata = lstatSync(scratch.directory, { bigint: true });
  const uid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || String(metadata.dev) !== scratch.device
    || String(metadata.ino) !== scratch.inode
    || (uid !== null && metadata.uid !== BigInt(uid))
    || (process.platform !== "win32" && (metadata.mode & 0o777n) !== 0o700n)
    || realpathSync(scratch.directory) !== scratch.directory
    // The worker has a sanitized environment; its tmpdir can differ from main's.
    // Main grants this exact private directory identity, not a worker-local path.
    || !basename(scratch.directory).startsWith(prefix(operationId))
  ) throw new CandidateViabilityError("invalid-request");
}

/** The main process owns this directory until the exact worker exit is observed. */
export function createAppUpdateScratch(operationId: string): {
  readonly identity: AppUpdateValidationScratch;
  readonly remove: () => void;
} {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), prefix(operationId)));
  try {
    chmodSync(directory, 0o700);
    const metadata = lstatSync(directory, { bigint: true });
    const identity = Object.freeze({
      directory,
      device: String(metadata.dev),
      inode: String(metadata.ino),
    });
    let removed = false;
    return {
      identity,
      remove: () => {
        if (removed) return;
        validateAppUpdateScratch(identity, operationId);
        const names = readdirSync(directory);
        // Never recursively traverse a replaced directory or unexpected entry.
        if (names.some((name) => !CLONE_FILES.has(name))) {
          throw new CandidateViabilityError("validation-failed");
        }
        for (const name of names) {
          validateAppUpdateScratch(identity, operationId);
          unlinkSync(join(directory, name));
        }
        validateAppUpdateScratch(identity, operationId);
        rmdirSync(directory);
        removed = true;
      },
    };
  } catch (error) {
    rmdirSync(directory);
    throw error;
  }
}

export function createAppUpdateCloneFile(
  scratch: AppUpdateValidationScratch,
  operationId: string,
): string {
  validateAppUpdateScratch(scratch, operationId);
  if (readdirSync(scratch.directory).length !== 0) {
    throw new CandidateViabilityError("invalid-request");
  }
  const path = join(scratch.directory, CLONE_NAME);
  closeSync(openSync(path, "wx", 0o600));
  validateAppUpdateScratch(scratch, operationId);
  return path;
}
