import { randomBytes } from "node:crypto";
import { constants, type Dir } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  FILE_OPEN_DIRECTORY,
  FILE_OPEN_NO_FOLLOW,
} from "../../node/platform-file-open-flags";

const STREAM_CHUNK_BYTES = 64 * 1024;
const WINDOWS = process.platform === "win32";
const LINUX = process.platform === "linux";

export interface PinnedExportPublishInput {
  readonly canonicalAncestor: string;
  readonly dev: string;
  readonly ino: string;
  readonly subdirectories: readonly string[];
  readonly fileName: string;
  readonly produced: string;
  readonly replacing: boolean;
}

function samePath(left: string, right: string): boolean {
  return WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function safeSegment(segment: string): boolean {
  return segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !segment.includes("/")
    && !segment.includes("\\");
}

async function streamToNewFile(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const source = await open(sourcePath, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
  let destination: FileHandle | undefined;
  let created = false;
  try {
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | FILE_OPEN_NO_FOLLOW,
    );
    created = true;
    const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    let readOffset = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, readOffset);
      if (bytesRead === 0) break;
      let writeOffset = 0;
      while (writeOffset < bytesRead) {
        const { bytesWritten } = await destination.write(
          buffer,
          writeOffset,
          bytesRead - writeOffset,
          readOffset + writeOffset,
        );
        if (bytesWritten <= 0) throw new Error("short-write");
        writeOffset += bytesWritten;
      }
      readOffset += bytesRead;
    }
    await destination.sync().catch(() => undefined);
    await destination.close();
    destination = undefined;
  } catch (error) {
    if (destination !== undefined) {
      await destination.close().catch(() => undefined);
    }
    if (created) {
      await rm(destinationPath, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await source.close().catch(() => undefined);
  }
}

/**
 * Publishes an approved CAD export in-process (compatible with packaged
 * Electron where the RunAsNode fuse is disabled) by pinning the verified
 * ancestor and each created subdirectory with open directory handles, stepping
 * one non-symlink segment at a time, and streaming into the target with
 * O_CREAT | O_EXCL | O_NOFOLLOW and cleanup on partial write failures.
 */
export async function publishToPinnedDirectory(
  input: PinnedExportPublishInput,
): Promise<void> {
  if (!safeSegment(input.fileName)) {
    throw new Error("invalid-filename");
  }
  for (const segment of input.subdirectories) {
    if (!safeSegment(segment)) throw new Error("invalid-segment");
  }

  const heldHandles: FileHandle[] = [];
  const heldDirs: Dir[] = [];
  try {
    const ancestorCanonical = await realpath(input.canonicalAncestor);
    if (!samePath(ancestorCanonical, input.canonicalAncestor)) {
      throw new Error("ancestor-identity-changed");
    }
    const ancestorLstat = await lstat(ancestorCanonical, { bigint: true });
    if (
      !ancestorLstat.isDirectory()
      || ancestorLstat.isSymbolicLink()
      || String(ancestorLstat.dev) !== input.dev
      || String(ancestorLstat.ino) !== input.ino
    ) {
      throw new Error("ancestor-identity-changed");
    }

    let currentDir = ancestorCanonical;
    let currentDev = ancestorLstat.dev;
    let currentIno = ancestorLstat.ino;
    let dirBase = ancestorCanonical;

    if (!WINDOWS) {
      const ancestorHandle = await open(
        ancestorCanonical,
        constants.O_RDONLY | FILE_OPEN_DIRECTORY | FILE_OPEN_NO_FOLLOW,
      );
      heldHandles.push(ancestorHandle);
      const pinned = await ancestorHandle.stat({ bigint: true });
      if (!pinned.isDirectory() || pinned.dev !== currentDev || pinned.ino !== currentIno) {
        throw new Error("ancestor-identity-changed");
      }
      if (LINUX) dirBase = `/proc/self/fd/${ancestorHandle.fd}`;
    } else {
      heldDirs.push(await opendir(ancestorCanonical));
    }

    // Create and descend one verified, non-symlink segment at a time.
    for (const segment of input.subdirectories) {
      const nextBase = join(dirBase, segment);
      const nextCanonical = join(currentDir, segment);
      try {
        await mkdir(nextBase);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
      }
      const entry = await lstat(nextBase, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("parent-symlink");
      }
      if (!WINDOWS) {
        const handle = await open(
          nextBase,
          constants.O_RDONLY | FILE_OPEN_DIRECTORY | FILE_OPEN_NO_FOLLOW,
        );
        heldHandles.push(handle);
        const opened = await handle.stat({ bigint: true });
        if (!opened.isDirectory() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
          throw new Error("parent-changed");
        }
        if (LINUX) dirBase = `/proc/self/fd/${handle.fd}`;
        else dirBase = nextCanonical;
      } else {
        const resolvedNext = await realpath(nextCanonical);
        if (!samePath(resolvedNext, nextCanonical)) {
          throw new Error("parent-symlink");
        }
        heldDirs.push(await opendir(nextCanonical));
        dirBase = nextCanonical;
      }
      currentDir = nextCanonical;
      currentDev = entry.dev;
      currentIno = entry.ino;
    }

    // Re-verify the pinned target directory immediately before creating the file.
    if (!LINUX) {
      const verifyDir = await lstat(currentDir, { bigint: true });
      const verifyCanonical = await realpath(currentDir);
      if (
        !verifyDir.isDirectory()
        || verifyDir.isSymbolicLink()
        || verifyDir.dev !== currentDev
        || verifyDir.ino !== currentIno
        || !samePath(verifyCanonical, currentDir)
      ) {
        throw new Error("parent-changed");
      }
    }

    const targetPath = join(dirBase, input.fileName);
    if (!input.replacing) {
      await streamToNewFile(input.produced, targetPath);
      return;
    }

    const existing = await lstat(targetPath).catch(() => undefined);
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error("target-symlink");
    }
    const temporaryPath = join(
      dirBase,
      `.${input.fileName}.${randomBytes(6).toString("hex")}.tmp`,
    );
    await streamToNewFile(input.produced, temporaryPath);
    try {
      const current = await lstat(targetPath).catch(() => undefined);
      if (current !== undefined && (current.isSymbolicLink() || !current.isFile())) {
        throw new Error("target-symlink");
      }
      if (!LINUX) {
        const verifyBeforeRename = await lstat(currentDir, { bigint: true });
        if (
          !verifyBeforeRename.isDirectory()
          || verifyBeforeRename.isSymbolicLink()
          || verifyBeforeRename.dev !== currentDev
          || verifyBeforeRename.ino !== currentIno
        ) {
          throw new Error("parent-changed");
        }
      }
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    for (const handle of heldHandles.reverse()) {
      await handle.close().catch(() => undefined);
    }
    for (const dir of heldDirs.reverse()) {
      await dir.close().catch(() => undefined);
    }
  }
}
