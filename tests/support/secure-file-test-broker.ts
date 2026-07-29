import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  resolve,
} from "node:path";

import {
  SecureFileError,
  type RuntimeSecureFileBroker,
  type SecureFileRead,
  type SecureFileReplace,
  type SecureFileRootCapability,
} from "../../src/server/secure-files";

type FileHandle = Awaited<ReturnType<typeof open>>;

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function unavailableIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SecureFileError(
      "unavailable",
      "The secure file operation was cancelled.",
    );
  }
}

function securePathSegments(path: string): string[] {
  const segments = path.split(/[\\/]/u);
  if (
    !path
    || isAbsolute(path)
    || /^[A-Za-z]:/u.test(path)
    || segments.some(
      (segment) =>
        !segment
        || segment === "."
        || segment === ".."
        || segment.includes("\0"),
    )
  ) {
    throw new SecureFileError("invalid", "The secure file path is invalid.");
  }
  return segments;
}

function sameIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function mappedFileError(error: unknown): SecureFileError {
  if (error instanceof SecureFileError) return error;
  const code = (
    typeof error === "object"
    && error !== null
    && "code" in error
  )
    ? String(error.code)
    : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new SecureFileError("not-found", "The secure file was not found.");
  }
  if (code === "ELOOP") {
    return new SecureFileError("unsafe", "The secure file path is unsafe.");
  }
  return new SecureFileError(
    "unavailable",
    "The secure file operation could not be completed.",
  );
}

async function verifiedHandle(
  root: SecureFileRootCapability,
  path: string,
  flags: number,
): Promise<FileHandle> {
  const segments = securePathSegments(path);
  const basename = segments.pop()!;
  const rootInfo = await lstat(root.root, { bigint: true });
  if (
    !rootInfo.isDirectory()
    || rootInfo.isSymbolicLink()
    || rootInfo.dev.toString(10) !== root.identity.dev
    || rootInfo.ino.toString(10) !== root.identity.ino
  ) {
    throw new SecureFileError("unsafe", "The secure file root is unsafe.");
  }

  let parent = root.root;
  for (const segment of segments) {
    const candidate = resolve(parent, segment);
    const info = await lstat(candidate, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SecureFileError(
        "unsafe",
        "A secure file parent folder is unsafe.",
      );
    }
    parent = candidate;
  }

  const target = resolve(parent, basename);
  const before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new SecureFileError("unsafe", "The secure file target is unsafe.");
  }
  const handle = await open(
    target,
    flags | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new SecureFileError(
        "unsafe",
        "The secure file changed while it was being opened.",
      );
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readHandle(
  handle: FileHandle,
  maxBytes: number,
): Promise<SecureFileRead> {
  const info = await handle.stat();
  if (!info.isFile()) {
    throw new SecureFileError("unsafe", "The secure file target is unsafe.");
  }
  if (info.size > maxBytes) {
    throw new SecureFileError(
      "too-large",
      "The secure file exceeds the supported size limit.",
    );
  }
  const content = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < content.length) {
    const { bytesRead } = await handle.read(
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const bounded = content.subarray(0, offset);
  return {
    content: bounded,
    digest: digest(bounded),
    size: bounded.byteLength,
    modifiedAt: info.mtime.toISOString(),
    mode: info.mode & 0o777,
  };
}

async function writeComplete(
  handle: FileHandle,
  content: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (bytesWritten < 1) {
      throw new SecureFileError(
        "unavailable",
        "The secure file could not be written completely.",
      );
    }
    offset += bytesWritten;
  }
  await handle.truncate(content.length);
}

/**
 * Test-only broker that keeps direct server tests on the same digest and
 * verified-handle boundary as the privileged runtime broker.
 */
export class SecureFileTestBroker implements RuntimeSecureFileBroker {
  async authorizeRoot(
    root: string,
    signal?: AbortSignal,
  ): Promise<SecureFileRootCapability> {
    unavailableIfAborted(signal);
    try {
      const canonicalRoot = await realpath(root);
      const info = await lstat(canonicalRoot, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || info.ino <= 0n) {
        throw new SecureFileError(
          "unsafe",
          "The secure file root is unsafe.",
        );
      }
      return {
        root: canonicalRoot,
        identity: {
          dev: info.dev.toString(10),
          ino: info.ino.toString(10),
        },
      };
    } catch (error) {
      throw mappedFileError(error);
    }
  }

  async verifyRoot(
    root: SecureFileRootCapability,
    signal?: AbortSignal,
  ): Promise<void> {
    unavailableIfAborted(signal);
    try {
      const info = await lstat(root.root, { bigint: true });
      if (
        !info.isDirectory()
        || info.isSymbolicLink()
        || info.dev.toString(10) !== root.identity.dev
        || info.ino.toString(10) !== root.identity.ino
      ) {
        throw new SecureFileError(
          "unsafe",
          "The secure file root changed after it was authorized.",
        );
      }
    } catch (error) {
      throw mappedFileError(error);
    }
  }

  async read(
    root: SecureFileRootCapability,
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<SecureFileRead> {
    unavailableIfAborted(signal);
    let handle: FileHandle | null = null;
    try {
      handle = await verifiedHandle(root, path, fsConstants.O_RDONLY);
      unavailableIfAborted(signal);
      return await readHandle(handle, maxBytes);
    } catch (error) {
      throw mappedFileError(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async replace(
    root: SecureFileRootCapability,
    path: string,
    content: Buffer,
    expectedDigest: string,
    expectedMode: number,
    mode: number,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<SecureFileReplace> {
    unavailableIfAborted(signal);
    if (content.byteLength > maxBytes) {
      throw new SecureFileError(
        "too-large",
        "The secure file exceeds the supported size limit.",
      );
    }
    let handle: FileHandle | null = null;
    try {
      handle = await verifiedHandle(root, path, fsConstants.O_RDWR);
      const current = await readHandle(handle, maxBytes);
      if (current.digest !== expectedDigest) {
        throw new SecureFileError(
          "conflict",
          "The secure file changed after it was opened.",
        );
      }
      if (current.mode !== (expectedMode & 0o777)) {
        throw new SecureFileError(
          "conflict",
          "The secure file permissions changed after it was opened.",
        );
      }
      unavailableIfAborted(signal);
      await writeComplete(handle, content);
      if (process.platform !== "win32") await handle.chmod(mode & 0o777);
      await handle.sync();
      const saved = await readHandle(handle, maxBytes);
      if (saved.digest !== digest(content)) {
        throw new SecureFileError(
          "conflict",
          "The secure file replacement could not be verified.",
        );
      }
      return {
        digest: saved.digest,
        size: saved.size,
        modifiedAt: saved.modifiedAt,
        mode: saved.mode,
      };
    } catch (error) {
      throw mappedFileError(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
