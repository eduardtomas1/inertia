import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  type BigIntStats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, normalize } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "./platform-file-open-flags.js";

export interface DirectRuntimeJournalRoot {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface DirectRuntimeJournalIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface DirectRuntimeJournalLeaf {
  readonly bytes: Buffer;
  readonly identity: DirectRuntimeJournalIdentity;
}

export interface DirectRuntimeJournalTestHooks {
  afterTemporaryFileClosed?(path: string): void;
  beforeReadFileOpen?(path: string): void;
  afterReadFileOpened?(path: string, handle: number): void;
  beforeRename?(sourcePath: string, targetPath: string): void;
  afterRename?(sourcePath: string, targetPath: string): void;
  beforeUnlink?(path: string): void;
}

const MAX_RUNTIME_DATA_ROOT_ENTRIES = 4_096;

export function directRuntimeJournalIdentityMatches(
  expected: DirectRuntimeJournalIdentity,
  actual: Pick<BigIntStats, "dev" | "ino">,
): boolean {
  return actual.dev === expected.device && actual.ino === expected.inode;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function hasTrustedPosixAuthority(info: Pick<BigIntStats, "mode" | "uid">): boolean {
  if (process.platform === "win32") return true;
  const effectiveUserId = typeof process.geteuid === "function"
    ? process.geteuid()
    : null;
  return effectiveUserId !== null
    && info.uid === BigInt(effectiveUserId)
    && (info.mode & 0o077n) === 0n;
}

function directoryInfo(path: string): BigIntStats | null {
  try {
    const info = lstatSync(path, { bigint: true });
    return !info.isSymbolicLink()
      && info.isDirectory()
      && hasTrustedPosixAuthority(info)
      ? info
      : null;
  } catch {
    return null;
  }
}

function leafInfo(path: string): BigIntStats | null {
  try {
    const info = lstatSync(path, { bigint: true });
    return !info.isSymbolicLink()
      && info.isFile()
      && hasTrustedPosixAuthority(info)
      ? info
      : null;
  } catch {
    return null;
  }
}

function validLeaf(name: string): boolean {
  return name.length > 0
    && name.length <= 180
    && name !== "."
    && name !== ".."
    && !/[\\/\0]/u.test(name);
}

function leafPath(root: DirectRuntimeJournalRoot, name: string): string {
  if (!validLeaf(name)) throw new Error("The runtime journal leaf is invalid.");
  return join(root.path, name);
}

export function pinDirectRuntimeJournalRoot(
  dataDirectory: string,
): DirectRuntimeJournalRoot {
  const path = realpathSync(dataDirectory);
  const info = directoryInfo(path);
  if (!info || !samePath(realpathSync(path), path)) {
    throw new Error("The runtime journal data root is unsafe.");
  }
  return { path, device: info.dev, inode: info.ino };
}

export function directRuntimeJournalRootIsPinned(
  root: DirectRuntimeJournalRoot,
): boolean {
  const info = directoryInfo(root.path);
  if (!info || !directRuntimeJournalIdentityMatches(root, info)) return false;
  try {
    return samePath(realpathSync(root.path), root.path);
  } catch {
    return false;
  }
}

export function pinDirectRuntimeJournalChildRoot(
  parent: DirectRuntimeJournalRoot,
  name: string,
): DirectRuntimeJournalRoot | null {
  if (!directRuntimeJournalRootIsPinned(parent)) return null;
  const path = leafPath(parent, name);
  const info = directoryInfo(path);
  if (!info) return null;
  try {
    return samePath(realpathSync(path), path)
      && directRuntimeJournalRootIsPinned(parent)
      ? { path, device: info.dev, inode: info.ino }
      : null;
  } catch {
    return null;
  }
}

export function createDirectRuntimeJournalChildRoot(
  parent: DirectRuntimeJournalRoot,
  name: string,
): DirectRuntimeJournalRoot | null {
  if (!directRuntimeJournalRootIsPinned(parent)) return null;
  const path = leafPath(parent, name);
  try {
    mkdirSync(path, { mode: 0o700 });
    if (!fsyncRoot(parent)) return null;
  } catch (error) {
    if (
      !error
      || typeof error !== "object"
      || !("code" in error)
      || error.code !== "EEXIST"
    ) return null;
  }
  return pinDirectRuntimeJournalChildRoot(parent, name);
}

export function renameDirectRuntimeJournalChildRoot(
  parent: DirectRuntimeJournalRoot,
  sourceName: string,
  targetName: string,
  identity: DirectRuntimeJournalIdentity,
  hooks?: DirectRuntimeJournalTestHooks,
): DirectRuntimeJournalRoot | null {
  const sourcePath = leafPath(parent, sourceName);
  const targetPath = leafPath(parent, targetName);
  try {
    const source = directoryInfo(sourcePath);
    if (
      !source
      || !directRuntimeJournalIdentityMatches(identity, source)
      || !directRuntimeJournalRootIsPinned(parent)
    ) return null;
    try {
      lstatSync(targetPath);
      return null;
    } catch (error) {
      if (
        !error
        || typeof error !== "object"
        || !("code" in error)
        || error.code !== "ENOENT"
      ) return null;
    }
    hooks?.beforeRename?.(sourcePath, targetPath);
    const confirmed = directoryInfo(sourcePath);
    if (
      !confirmed
      || !directRuntimeJournalIdentityMatches(identity, confirmed)
      || !directRuntimeJournalRootIsPinned(parent)
    ) return null;
    renameSync(sourcePath, targetPath);
    hooks?.afterRename?.(sourcePath, targetPath);
    const target = directoryInfo(targetPath);
    if (
      !target
      || !directRuntimeJournalIdentityMatches(identity, target)
      || !fsyncRoot(parent)
    ) return null;
    return { path: targetPath, device: target.dev, inode: target.ino };
  } catch {
    return null;
  }
}

export function removeDirectRuntimeJournalChildRoot(
  parent: DirectRuntimeJournalRoot,
  name: string,
  identity: DirectRuntimeJournalIdentity,
): boolean {
  const path = leafPath(parent, name);
  try {
    const current = directoryInfo(path);
    if (
      !current
      || !directRuntimeJournalIdentityMatches(identity, current)
      || !directRuntimeJournalRootIsPinned(parent)
    ) return false;
    const directory = opendirSync(path);
    try {
      if (directory.readSync() !== null) return false;
    } finally {
      directory.closeSync();
    }
    const confirmed = directoryInfo(path);
    if (
      !confirmed
      || !directRuntimeJournalIdentityMatches(identity, confirmed)
      || !directRuntimeJournalRootIsPinned(parent)
    ) return false;
    rmdirSync(path);
    return fsyncRoot(parent);
  } catch {
    return false;
  }
}

export function directRuntimeJournalRootIsEmpty(
  root: DirectRuntimeJournalRoot,
): boolean {
  if (!directRuntimeJournalRootIsPinned(root)) return false;
  try {
    const directory = opendirSync(root.path);
    try {
      if (directory.readSync() !== null) return false;
    } finally {
      directory.closeSync();
    }
    return directRuntimeJournalRootIsPinned(root);
  } catch {
    return false;
  }
}

function fsyncRoot(root: DirectRuntimeJournalRoot): boolean {
  if (!directRuntimeJournalRootIsPinned(root)) return false;
  try {
    const handle = openSync(root.path, "r");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    return directRuntimeJournalRootIsPinned(root);
  } catch {
    // Windows does not expose directory fsync. Its direct-leaf rename remains
    // atomic; root identity is still checked before and after the operation.
    return process.platform === "win32" && directRuntimeJournalRootIsPinned(root);
  }
}

export function listDirectRuntimeJournalLeaves(
  root: DirectRuntimeJournalRoot,
  prefix: string,
  maxMatches: number,
  maxTotalEntries = MAX_RUNTIME_DATA_ROOT_ENTRIES,
): string[] {
  if (
    !validLeaf(prefix)
    || !Number.isSafeInteger(maxMatches)
    || maxMatches < 1
    || !Number.isSafeInteger(maxTotalEntries)
    || maxTotalEntries < 1
    || maxTotalEntries > MAX_RUNTIME_DATA_ROOT_ENTRIES
    || !directRuntimeJournalRootIsPinned(root)
  ) {
    throw new Error("The runtime journal data root identity changed.");
  }
  const names: string[] = [];
  let totalEntries = 0;
  const directory = opendirSync(root.path);
  try {
    let entry = directory.readSync();
    while (entry) {
      totalEntries += 1;
      if (totalEntries > maxTotalEntries) {
        throw new Error("The runtime journal data root entry bound was exceeded.");
      }
      if (entry.name.startsWith(prefix)) {
        names.push(entry.name);
        if (names.length > maxMatches) {
          throw new Error("The runtime journal storage bound was exceeded.");
        }
      }
      entry = directory.readSync();
    }
  } finally {
    directory.closeSync();
  }
  if (!directRuntimeJournalRootIsPinned(root)) {
    throw new Error("The runtime journal data root identity changed.");
  }
  return names;
}

export function directRuntimeJournalLeafExists(
  root: DirectRuntimeJournalRoot,
  name: string,
): boolean {
  if (!directRuntimeJournalRootIsPinned(root)) {
    throw new Error("The runtime journal data root identity changed.");
  }
  const path = leafPath(root, name);
  try {
    lstatSync(path);
    return directRuntimeJournalRootIsPinned(root);
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) return false;
    throw error;
  }
}

export function readDirectRuntimeJournalLeaf(
  root: DirectRuntimeJournalRoot,
  name: string,
  maxBytes: number,
  hooks?: DirectRuntimeJournalTestHooks,
): DirectRuntimeJournalLeaf | null {
  if (!directRuntimeJournalRootIsPinned(root)) {
    throw new Error("The runtime journal data root identity changed.");
  }
  const path = leafPath(root, name);
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) return null;
    throw error;
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || !hasTrustedPosixAuthority(before)
    || before.size < 1n
    || before.size > BigInt(maxBytes)
  ) throw new Error("A runtime journal leaf is unsafe.");
  hooks?.beforeReadFileOpen?.(path);
  const flags = fsConstants.O_RDONLY
    | (process.platform === "win32"
      ? 0
      : FILE_OPEN_NO_FOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
  const handle = openSync(path, flags);
  try {
    const opened = fstatSync(handle, { bigint: true });
    const identity = { device: before.dev, inode: before.ino };
    if (
      !opened.isFile()
      || !hasTrustedPosixAuthority(opened)
      || opened.size < 1n
      || opened.size > BigInt(maxBytes)
      || !directRuntimeJournalIdentityMatches(identity, opened)
    ) throw new Error("A runtime journal leaf identity changed.");
    hooks?.afterReadFileOpened?.(path, handle);
    const bounded = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.byteLength) {
      const count = readSync(
        handle,
        bounded,
        bytesRead,
        bounded.byteLength - bytesRead,
        bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const afterRead = fstatSync(handle, { bigint: true });
    if (
      bytesRead < 1
      || bytesRead > maxBytes
      || BigInt(bytesRead) !== opened.size
      || afterRead.size !== opened.size
      || !directRuntimeJournalIdentityMatches(identity, afterRead)
    ) throw new Error("A runtime journal leaf changed while it was read.");
    const bytes = bounded.subarray(0, bytesRead);
    const after = lstatSync(path, { bigint: true });
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || !hasTrustedPosixAuthority(after)
      || after.size !== opened.size
      || !directRuntimeJournalIdentityMatches(identity, after)
      || !directRuntimeJournalRootIsPinned(root)
    ) throw new Error("A runtime journal leaf identity changed.");
    return { bytes, identity };
  } finally {
    closeSync(handle);
  }
}

export function writeDirectRuntimeJournalLeaf(
  root: DirectRuntimeJournalRoot,
  temporaryName: string,
  targetName: string,
  bytes: Buffer,
  hooks?: DirectRuntimeJournalTestHooks,
): boolean {
  if (
    bytes.byteLength < 1
    || !directRuntimeJournalRootIsPinned(root)
  ) return false;
  const temporaryPath = leafPath(root, temporaryName);
  const targetPath = leafPath(root, targetName);
  let handle: number | null = null;
  let identity: DirectRuntimeJournalIdentity | null = null;
  try {
    const flags = fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (process.platform === "win32" ? 0 : FILE_OPEN_NO_FOLLOW);
    handle = openSync(temporaryPath, flags, 0o600);
    if (process.platform !== "win32") fchmodSync(handle, 0o600);
    writeFileSync(handle, bytes);
    fsyncSync(handle);
    const opened = fstatSync(handle, { bigint: true });
    identity = { device: opened.dev, inode: opened.ino };
    closeSync(handle);
    handle = null;
    if (!fsyncRoot(root)) return false;
    hooks?.afterTemporaryFileClosed?.(temporaryPath);
    const named = leafInfo(temporaryPath);
    if (
      !named
      || !directRuntimeJournalIdentityMatches(identity, named)
      || !directRuntimeJournalRootIsPinned(root)
    ) return false;
    hooks?.beforeRename?.(temporaryPath, targetPath);
    const confirmedTemporary = leafInfo(temporaryPath);
    if (
      !confirmedTemporary
      || !directRuntimeJournalIdentityMatches(identity, confirmedTemporary)
      || !directRuntimeJournalRootIsPinned(root)
    ) return false;
    renameSync(temporaryPath, targetPath);
    const committed = leafInfo(targetPath);
    if (
      !committed
      || !directRuntimeJournalIdentityMatches(identity, committed)
      || !fsyncRoot(root)
    ) return false;
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== null) {
      try { closeSync(handle); } catch { /* The write already failed closed. */ }
    }
  }
}

/**
 * Publishes a leaf whose exclusive temporary file lives inside a separately
 * pinned session directory. Renaming that directory makes every delayed
 * publisher's source path disappear atomically before retirement scans the
 * canonical journal root.
 */
export function writeDirectRuntimeJournalLeafFromRoot(
  temporaryRoot: DirectRuntimeJournalRoot,
  temporaryName: string,
  targetRoot: DirectRuntimeJournalRoot,
  targetName: string,
  bytes: Buffer,
  hooks?: DirectRuntimeJournalTestHooks,
): boolean {
  if (
    bytes.byteLength < 1
    || temporaryRoot.device !== targetRoot.device
    || !directRuntimeJournalRootIsPinned(temporaryRoot)
    || !directRuntimeJournalRootIsPinned(targetRoot)
  ) return false;
  const temporaryPath = leafPath(temporaryRoot, temporaryName);
  const targetPath = leafPath(targetRoot, targetName);
  let handle: number | null = null;
  let identity: DirectRuntimeJournalIdentity | null = null;
  try {
    const flags = fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (process.platform === "win32" ? 0 : FILE_OPEN_NO_FOLLOW);
    handle = openSync(temporaryPath, flags, 0o600);
    if (process.platform !== "win32") fchmodSync(handle, 0o600);
    writeFileSync(handle, bytes);
    fsyncSync(handle);
    const opened = fstatSync(handle, { bigint: true });
    identity = { device: opened.dev, inode: opened.ino };
    closeSync(handle);
    handle = null;
    if (!fsyncRoot(temporaryRoot)) return false;
    hooks?.afterTemporaryFileClosed?.(temporaryPath);
    const named = leafInfo(temporaryPath);
    if (
      !named
      || !directRuntimeJournalIdentityMatches(identity, named)
      || !directRuntimeJournalRootIsPinned(temporaryRoot)
      || !directRuntimeJournalRootIsPinned(targetRoot)
    ) return false;
    hooks?.beforeRename?.(temporaryPath, targetPath);
    const confirmed = leafInfo(temporaryPath);
    if (
      !confirmed
      || !directRuntimeJournalIdentityMatches(identity, confirmed)
      || !directRuntimeJournalRootIsPinned(temporaryRoot)
      || !directRuntimeJournalRootIsPinned(targetRoot)
    ) return false;
    renameSync(temporaryPath, targetPath);
    hooks?.afterRename?.(temporaryPath, targetPath);
    const committed = leafInfo(targetPath);
    return !!committed
      && directRuntimeJournalIdentityMatches(identity, committed)
      && fsyncRoot(targetRoot);
  } catch {
    return false;
  } finally {
    if (handle !== null) {
      try { closeSync(handle); } catch { /* The write already failed closed. */ }
    }
  }
}

export function renameDirectRuntimeJournalLeaf(
  root: DirectRuntimeJournalRoot,
  sourceName: string,
  targetName: string,
  identity: DirectRuntimeJournalIdentity,
  hooks?: DirectRuntimeJournalTestHooks,
): boolean {
  const sourcePath = leafPath(root, sourceName);
  const targetPath = leafPath(root, targetName);
  try {
    const source = leafInfo(sourcePath);
    if (
      !source
      || !directRuntimeJournalIdentityMatches(identity, source)
      || !directRuntimeJournalRootIsPinned(root)
    ) return false;
    hooks?.beforeRename?.(sourcePath, targetPath);
    const confirmedSource = leafInfo(sourcePath);
    if (
      !confirmedSource
      || !directRuntimeJournalIdentityMatches(identity, confirmedSource)
      || !directRuntimeJournalRootIsPinned(root)
    ) return false;
    renameSync(sourcePath, targetPath);
    hooks?.afterRename?.(sourcePath, targetPath);
    const target = leafInfo(targetPath);
    return !!target
      && directRuntimeJournalIdentityMatches(identity, target)
      && fsyncRoot(root);
  } catch {
    return false;
  }
}

export function discardDirectRuntimeJournalLeaf(
  root: DirectRuntimeJournalRoot,
  name: string,
  hooks?: DirectRuntimeJournalTestHooks,
): boolean {
  const path = leafPath(root, name);
  const leaf = leafInfo(path);
  if (!leaf || !directRuntimeJournalRootIsPinned(root)) return false;
  return unlinkDirectRuntimeJournalLeaf(
    root,
    name,
    { device: leaf.dev, inode: leaf.ino },
    hooks,
  );
}

export function unlinkDirectRuntimeJournalLeaf(
  root: DirectRuntimeJournalRoot,
  name: string,
  identity: DirectRuntimeJournalIdentity,
  hooks?: DirectRuntimeJournalTestHooks,
): boolean {
  const path = leafPath(root, name);
  try {
    const current = leafInfo(path);
    if (
      !current
      || !directRuntimeJournalIdentityMatches(identity, current)
      || !directRuntimeJournalRootIsPinned(root)
    ) return false;
    hooks?.beforeUnlink?.(path);
    const confirmed = leafInfo(path);
    if (
      !confirmed
      || !directRuntimeJournalIdentityMatches(identity, confirmed)
      || !directRuntimeJournalRootIsPinned(root)
    ) return false;
    unlinkSync(path);
    return fsyncRoot(root);
  } catch {
    return false;
  }
}
