import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import { readIndexSync } from "./commit-index";
import {
  acquireIndexReservationSync,
  releaseOwnedCommitReservation,
  reservationBytes,
  sameCommitLockIdentity,
} from "./commit-transaction";
import { runGit } from "./runner";
import { GitError } from "./types";

/** Restore only our index entry, while holding Git's native writer lock. */
export async function restoreReversalIndexEntry(
  root: string,
  path: string,
  expected: { mode: string; oid: string },
  restored: { mode: string; oid: string },
  verifyContext: () => Promise<void>,
): Promise<void> {
  await verifyContext();
  const located = await runGit(root, [
    "rev-parse", "--path-format=absolute", "--git-path", "index",
  ], { maxOutputBytes: 4_096, failureMessage: "Unable to locate the reversal index." });
  const indexPath = located.stdout.toString("utf8").replace(/(?:\r\n|\n)$/u, "");
  if (!isAbsolute(indexPath) || indexPath.includes("\0")) {
    throw new GitError("conflict", "The repository index could not be verified.");
  }
  const directory = dirname(indexPath);
  const canonicalDirectory = realpathSync.native(directory);
  const directoryIdentity = lstatSync(directory, { bigint: true });
  if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) {
    throw new GitError("conflict", "The repository index directory changed.");
  }
  const verifyDirectory = (): void => {
    const current = lstatSync(directory, { bigint: true });
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || realpathSync.native(directory) !== canonicalDirectory
      || !sameCommitLockIdentity(directoryIdentity, current)
    ) throw new GitError("conflict", "The repository index directory changed.");
  };
  const lockPath = `${indexPath}.lock`;
  const token = randomUUID();
  const lockIdentity = acquireIndexReservationSync(lockPath, token);
  let scratch: string | null = null;
  let installed = false;
  try {
    const originalIdentity = lstatSync(indexPath, { bigint: true });
    if (!originalIdentity.isFile() || originalIdentity.isSymbolicLink()) {
      throw new GitError("conflict", "The repository index is not a direct file.");
    }
    const original = readIndexSync(indexPath);
    scratch = await mkdtemp(join(tmpdir(), "inertia-reversal-index-"));
    const stage = join(scratch, "index");
    await writeFile(stage, original, { flag: "wx", mode: 0o600 });
    const environment = { GIT_INDEX_FILE: stage };
    const listed = await runGit(root, ["ls-files", "--stage", "-z", "--", path], {
      environment, maxOutputBytes: 4_352,
      failureMessage: "Unable to verify the staged reversal entry.",
    });
    if (listed.stdout.toString("utf8") !== `${expected.mode} ${expected.oid} 0\t${path}\0`) {
      throw new GitError("conflict", "Newer staged changes were preserved; the reversal needs recovery.");
    }
    await runGit(root, ["update-index", "--cacheinfo", restored.mode, restored.oid, path], {
      environment, maxOutputBytes: 256,
      failureMessage: "Unable to restore the staged reversal entry.",
    });
    const replacement = readIndexSync(stage);
    await verifyContext();
    verifyDirectory();
    const descriptor = openSync(lockPath, constants.O_RDWR | FILE_OPEN_NO_FOLLOW);
    try {
      const openedLock = fstatSync(descriptor, { bigint: true });
      if (
        !openedLock.isFile()
        || openedLock.nlink !== 1n
        || openedLock.size > 256n
        || !readFileSync(descriptor).equals(reservationBytes(token, "index"))
        || !sameCommitLockIdentity(lockIdentity, openedLock)
        || !sameCommitLockIdentity(lockIdentity, lstatSync(lockPath, { bigint: true }))
        || !sameCommitLockIdentity(originalIdentity, lstatSync(indexPath, { bigint: true }))
        || !readIndexSync(indexPath).equals(original)
      ) throw new GitError("conflict", "The repository index changed during reversal recovery.");
      // Keep the same native lock throughout validation and publication. Git
      // writers cannot change the real index while the private copy is edited.
      ftruncateSync(descriptor, 0);
      // readFileSync advanced the descriptor; explicitly write from byte zero.
      let written = 0;
      while (written < replacement.length) {
        written += writeSync(descriptor, replacement, written, replacement.length - written, written);
      }
      fchmodSync(descriptor, Number(originalIdentity.mode & 0o777n));
      fsyncSync(descriptor);
      verifyDirectory();
      if (!sameCommitLockIdentity(lockIdentity, lstatSync(lockPath, { bigint: true }))) {
        throw new GitError("conflict", "The reversal index lock was replaced.");
      }
      renameSync(lockPath, indexPath);
      installed = true;
    } finally {
      closeSync(descriptor);
    }
  } finally {
    try {
      if (!installed) {
        // The marker remains intact on every asynchronous failure. If publication
        // failed after writing index bytes, retain the lock for manual recovery.
        verifyDirectory();
        await releaseOwnedCommitReservation(lockPath, token, "index", lockIdentity);
      }
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }
}
