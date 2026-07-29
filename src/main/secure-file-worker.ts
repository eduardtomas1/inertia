import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  rename,
  stat,
  unlink,
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
        "The staged file could not be written completely.",
      );
    }
    offset += bytesWritten;
  }
  await handle.truncate(content.length);
}

async function enterVerifiedParent(request: SecureFileRequest): Promise<string> {
  const rootInfo = await stat(".", { bigint: true });
  if (
    !rootInfo.isDirectory()
    || !sameIdentity(identity(rootInfo), request.rootIdentity)
  ) {
    throw new SecureFileWorkerError(
      "unsafe",
      "The project root changed before the file operation started.",
    );
  }
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
  for (const [index, segment] of segments.entries()) {
    const before = await lstat(segment, { bigint: true }).catch(() => null);
    if (!before?.isDirectory() || before.isSymbolicLink()) {
      throw new SecureFileWorkerError(
        before ? "unsafe" : "not-found",
        "A parent folder is missing or no longer safe.",
      );
    }
    process.chdir(segment);
    const entered = await stat(".", { bigint: true });
    if (
      !entered.isDirectory()
      || !sameIdentity(
        identity(entered),
        request.parentIdentities[index]!,
      )
    ) {
      throw new SecureFileWorkerError(
        "unsafe",
        "A parent folder changed while it was being opened.",
      );
    }
  }
  return basename;
}

async function openVerifiedFile(
  basename: string,
  maxBytes: number,
  expectedIdentity?: SecureFileIdentity,
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
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
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

function assertAuthorizedNamespace(
  request: SecureFileRequest,
  parentSegments: readonly string[],
): void {
  const expected = resolve(request.root, ...parentSegments);
  let current: string;
  try {
    current = resolve(process.cwd());
  } catch {
    throw new SecureFileWorkerError(
      "unsafe",
      "The selected parent folder is no longer attached to the project.",
    );
  }
  const comparable = (value: string): string => (
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value
  );
  if (comparable(current) !== comparable(expected)) {
    throw new SecureFileWorkerError(
      "unsafe",
      "The selected parent folder moved outside the project.",
    );
  }
}

async function syncCurrentDirectory(): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(".", fsConstants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function replace(
  request: Extract<SecureFileRequest, { operation: "replace" }>,
  basename: string,
): Promise<SecureFileResult> {
  const content = Buffer.from(request.contentBase64, "base64");
  const parentSegments = secureFilePathSegments(request.path)!.slice(0, -1);
  const initial = await openVerifiedFile(
    basename,
    request.maxBytes,
    request.targetIdentity,
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
  } finally {
    await initial.handle.close();
  }

  const temporary = `.inertia-save-${randomUUID()}.tmp`;
  let staged = false;
  try {
    const stage = await open(
      temporary,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    staged = true;
    try {
      await writeComplete(stage, content);
      if (process.platform !== "win32") {
        await stage.chmod(request.mode & 0o777);
      }
      await stage.sync();
    } finally {
      await stage.close();
    }

    const current = await openVerifiedFile(
      basename,
      request.maxBytes,
      request.targetIdentity,
    );
    try {
      if (current.metadata.digest !== request.expectedDigest) {
        throw new SecureFileWorkerError(
          "conflict",
          "The selected file changed while the replacement was staged.",
        );
      }
      if (current.metadata.mode !== request.expectedMode) {
        throw new SecureFileWorkerError(
          "conflict",
          "The selected file permissions changed while the replacement was staged.",
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

    assertAuthorizedNamespace(request, parentSegments);
    await rename(temporary, basename);
    staged = false;
    await syncCurrentDirectory();
    const saved = await openVerifiedFile(basename, request.maxBytes);
    try {
      if (saved.metadata.digest !== digest(content)) {
        throw new SecureFileWorkerError(
          "conflict",
          "The replacement file could not be verified.",
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
    if (staged) await unlink(temporary).catch(() => undefined);
  }
}

export async function performSecureFileOperation(
  value: unknown,
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
    const basename = await enterVerifiedParent(request);
    if (request.operation === "replace") {
      return await replace(request, basename);
    }
    const opened = await openVerifiedFile(
      basename,
      request.maxBytes,
      request.targetIdentity,
    );
    try {
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
