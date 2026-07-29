import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseSecureFileRequest,
  secureFilePathSegments,
  type SecureFileIdentity,
  type SecureFileMetadata,
  type SecureFileRequest,
  type SecureFileResult,
} from "../node/secure-file-protocol.js";

class SecureFileWorkerError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "invalid"
      | "not-found"
      | "too-large"
      | "unsafe"
      | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

function sameIdentity(
  left: SecureFileIdentity,
  right: SecureFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identity(info: { dev: bigint; ino: bigint }): SecureFileIdentity {
  return {
    dev: info.dev.toString(10),
    ino: info.ino.toString(10),
  };
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<{ content: Buffer; metadata: SecureFileMetadata }> {
  const info = await handle.stat();
  if (!info.isFile()) {
    throw new SecureFileWorkerError(
      "unsafe",
      "The selected path is not a regular file.",
    );
  }
  if (info.size > maxBytes) {
    throw new SecureFileWorkerError(
      "too-large",
      "The selected file exceeds the supported size limit.",
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
    metadata: {
      digest: digest(bounded),
      size: bounded.byteLength,
      modifiedAt: info.mtime.toISOString(),
      mode: info.mode & 0o777,
    },
  };
}

async function writeComplete(
  handle: Awaited<ReturnType<typeof open>>,
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
      throw new SecureFileWorkerError(
        "unavailable",
        "The selected file could not be written completely.",
      );
    }
    offset += bytesWritten;
  }
  await handle.truncate(content.length);
}

interface SecureFileWorkerHooks {
  beforePinnedWrite?(): Promise<void> | void;
  writePinned?(
    handle: Awaited<ReturnType<typeof open>>,
    content: Buffer,
  ): Promise<void>;
}

function comparablePath(value: string): string {
  return process.platform === "win32"
    ? value.normalize("NFC").toLocaleLowerCase("en-US")
    : value;
}

async function verifiedDirectory(
  path: string,
  expectedIdentity: SecureFileIdentity,
  message: string,
): Promise<void> {
  const info = await lstat(path, { bigint: true }).catch(() => null);
  if (
    !info?.isDirectory()
    || info.isSymbolicLink()
    || !sameIdentity(identity(info), expectedIdentity)
  ) {
    throw new SecureFileWorkerError(
      "unsafe",
      message,
    );
  }
}

async function assertPinnedNamespace(
  request: SecureFileRequest,
  parentSegments: readonly string[],
): Promise<void> {
  await verifiedDirectory(
    request.root,
    request.rootIdentity,
    "The project root changed before the file operation completed.",
  );
  let cursor = request.root;
  for (const [index, segment] of parentSegments.entries()) {
    cursor = resolve(cursor, segment);
    await verifiedDirectory(
      cursor,
      request.parentIdentities[index]!,
      "A parent folder is missing or no longer safe.",
    );
  }
  const expectedParentIdentity = parentSegments.length > 0
    ? request.parentIdentities[parentSegments.length - 1]!
    : request.rootIdentity;
  const pinned = await stat(".", { bigint: true }).catch(() => null);
  if (
    !pinned?.isDirectory()
    || !sameIdentity(identity(pinned), expectedParentIdentity)
  ) {
    throw new SecureFileWorkerError(
      "unsafe",
      "The secure file helper is no longer attached to the selected parent folder.",
    );
  }
  const [currentCanonical, expectedCanonical] = await Promise.all([
    realpath(".").catch(() => null),
    realpath(cursor).catch(() => null),
  ]);
  if (
    !currentCanonical
    || !expectedCanonical
    || comparablePath(currentCanonical) !== comparablePath(expectedCanonical)
  ) {
    throw new SecureFileWorkerError(
      "unsafe",
      "The selected parent folder moved outside the project.",
    );
  }
  // A rename or reparse-point substitution between the identity and canonical
  // checks must also fail closed.
  await verifiedDirectory(
    request.root,
    request.rootIdentity,
    "The project root changed before the file operation completed.",
  );
  cursor = request.root;
  for (const [index, segment] of parentSegments.entries()) {
    cursor = resolve(cursor, segment);
    await verifiedDirectory(
      cursor,
      request.parentIdentities[index]!,
      "A parent folder is missing or no longer safe.",
    );
  }
}

async function enterVerifiedParent(
  request: SecureFileRequest,
): Promise<{ basename: string; parentSegments: string[] }> {
  const segments = secureFilePathSegments(request.path);
  if (!segments) {
    throw new SecureFileWorkerError(
      "invalid",
      "The selected file path is invalid.",
    );
  }
  const basename = segments.pop();
  if (!basename) {
    throw new SecureFileWorkerError(
      "invalid",
      "The selected file path is invalid.",
    );
  }
  await assertPinnedNamespace(request, segments);
  return { basename, parentSegments: segments };
}

async function openVerifiedFile(
  basename: string,
  maxBytes: number,
  expectedIdentity?: SecureFileIdentity,
  writable = false,
): Promise<{
  handle: Awaited<ReturnType<typeof open>>;
  content: Buffer;
  metadata: SecureFileMetadata;
  linkCount: number;
}> {
  const before = await lstat(basename, { bigint: true }).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new SecureFileWorkerError(
      before ? "unsafe" : "not-found",
      "The selected file is missing or no longer safe.",
    );
  }
  if (
    expectedIdentity
    && !sameIdentity(identity(before), expectedIdentity)
  ) {
    throw new SecureFileWorkerError(
      "conflict",
      "The selected file changed before it was opened.",
    );
  }
  const handle = await open(
    basename,
    (writable ? fsConstants.O_RDWR : fsConstants.O_RDONLY)
      | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedIdentity = await handle.stat({ bigint: true });
    if (
      !openedIdentity.isFile()
      || !sameIdentity(identity(before), identity(openedIdentity))
    ) {
      throw new SecureFileWorkerError(
        "unsafe",
        "The selected file changed while it was being opened.",
      );
    }
    const read = await readHandle(handle, maxBytes);
    return {
      handle,
      ...read,
      linkCount: Number(openedIdentity.nlink),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function replace(
  request: Extract<SecureFileRequest, { operation: "replace" }>,
  basename: string,
  parentSegments: readonly string[],
  hooks: SecureFileWorkerHooks,
): Promise<SecureFileResult> {
  const content = Buffer.from(request.contentBase64, "base64");
  const initial = await openVerifiedFile(
    basename,
    request.maxBytes,
    request.targetIdentity,
    true,
  );
  try {
    if (initial.metadata.digest !== request.expectedDigest) {
      throw new SecureFileWorkerError(
        "conflict",
        "The selected file changed after it was opened.",
      );
    }
    if (initial.metadata.mode !== request.expectedMode) {
      throw new SecureFileWorkerError(
        "conflict",
        "The selected file permissions changed after it was opened.",
      );
    }
    if (initial.linkCount !== 1) {
      throw new SecureFileWorkerError(
        "unsafe",
        "Files with multiple hard links cannot be replaced safely.",
      );
    }
    await assertPinnedNamespace(request, parentSegments);
    const current = await openVerifiedFile(
      basename,
      request.maxBytes,
      request.targetIdentity,
    );
    try {
      if (current.metadata.digest !== request.expectedDigest) {
        throw new SecureFileWorkerError(
          "conflict",
          "The selected file changed before it was saved.",
        );
      }
      if (current.metadata.mode !== request.expectedMode) {
        throw new SecureFileWorkerError(
          "conflict",
          "The selected file permissions changed before it was saved.",
        );
      }
      if (current.linkCount !== 1) {
        throw new SecureFileWorkerError(
          "unsafe",
          "Files with multiple hard links cannot be replaced safely.",
        );
      }
    } finally {
      await current.handle.close();
    }
    await hooks.beforePinnedWrite?.();
    await assertPinnedNamespace(request, parentSegments);
    const finalBinding = await openVerifiedFile(
      basename,
      request.maxBytes,
      request.targetIdentity,
    );
    try {
      if (
        finalBinding.metadata.digest !== request.expectedDigest
        || finalBinding.metadata.mode !== request.expectedMode
      ) {
        throw new SecureFileWorkerError(
          "conflict",
          "The selected file changed immediately before it was saved.",
        );
      }
      if (finalBinding.linkCount !== 1) {
        throw new SecureFileWorkerError(
          "unsafe",
          "Files with multiple hard links cannot be replaced safely.",
        );
      }
    } finally {
      await finalBinding.handle.close();
    }
    const pinnedIdentity = await initial.handle.stat({ bigint: true });
    if (
      !pinnedIdentity.isFile()
      || !sameIdentity(identity(pinnedIdentity), request.targetIdentity)
      || Number(pinnedIdentity.nlink) !== 1
    ) {
      throw new SecureFileWorkerError(
        "conflict",
        "The selected file binding changed immediately before it was saved.",
      );
    }
    const immediatelyBeforeWrite = await readHandle(
      initial.handle,
      request.maxBytes,
    );
    if (
      immediatelyBeforeWrite.metadata.digest !== request.expectedDigest
      || immediatelyBeforeWrite.metadata.mode !== request.expectedMode
    ) {
      throw new SecureFileWorkerError(
        "conflict",
        "The selected file changed immediately before it was saved.",
      );
    }
    try {
      await (hooks.writePinned ?? writeComplete)(initial.handle, content);
      if (process.platform !== "win32") {
        await initial.handle.chmod(request.mode & 0o777);
      }
      await initial.handle.sync();
    } catch (error) {
      try {
        await writeComplete(initial.handle, initial.content);
        if (process.platform !== "win32") {
          await initial.handle.chmod(request.expectedMode & 0o777);
        }
        await initial.handle.sync();
      } catch {
        throw new SecureFileWorkerError(
          "unavailable",
          "The interrupted save could not restore the original file.",
        );
      }
      throw error;
    }
    await assertPinnedNamespace(request, parentSegments);
    const saved = await openVerifiedFile(
      basename,
      request.maxBytes,
      request.targetIdentity,
    );
    try {
      if (saved.metadata.digest !== digest(content)) {
        throw new SecureFileWorkerError(
          "conflict",
          "The replacement file could not be verified.",
        );
      }
      if (saved.linkCount !== 1) {
        throw new SecureFileWorkerError(
          "unsafe",
          "The saved file unexpectedly has multiple hard links.",
        );
      }
      return {
        ok: true,
        operation: "replace",
        metadata: saved.metadata,
      };
    } finally {
      await saved.handle.close();
    }
  } finally {
    await initial.handle.close();
  }
}

export async function performSecureFileOperation(
  value: unknown,
  hooks: SecureFileWorkerHooks = {},
): Promise<SecureFileResult> {
  const request = parseSecureFileRequest(value);
  if (!request) {
    return {
      ok: false,
      code: "invalid",
      message: "The secure file request was invalid.",
    };
  }
  try {
    const { basename, parentSegments } = await enterVerifiedParent(request);
    if (request.operation === "replace") {
      return await replace(request, basename, parentSegments, hooks);
    }
    const opened = await openVerifiedFile(
      basename,
      request.maxBytes,
      request.targetIdentity,
    );
    try {
      await assertPinnedNamespace(request, parentSegments);
      return {
        ok: true,
        operation: "read",
        contentBase64: opened.content.toString("base64"),
        metadata: opened.metadata,
      };
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    if (error instanceof SecureFileWorkerError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return {
      ok: false,
      code: "unavailable",
      message: "The secure file operation could not be completed.",
    };
  }
}

const parentPort = process.parentPort;
if (parentPort) {
  parentPort.once("message", (event) => {
    void performSecureFileOperation(event.data).then((result) => {
      parentPort.postMessage(result);
      setImmediate(() => process.exit(result.ok ? 0 : 1));
    });
  });
}
