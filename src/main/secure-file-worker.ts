import { lstat, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseSecureFileRequest,
  secureFilePathSegments,
  type SecureFileIdentity,
  type SecureFileRequest,
  type SecureFileResult,
} from "../node/secure-file-protocol.js";
import {
  identity,
  openVerifiedFile,
  sameIdentity,
  SecureFileOperationError,
} from "./secure-file-io.js";
import {
  recoverSecureFileTransactions,
  replaceSecureFileTransaction,
  type SecureFileTransactionHooks,
} from "./secure-file-transaction.js";
import {
  parseSecureFileWorkerRequest,
  type SecureFileWorkerEvent,
} from "./secure-file-worker-protocol.js";

export type SecureFileWorkerHooks = SecureFileTransactionHooks;

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
    throw new SecureFileOperationError("unsafe", message);
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
    throw new SecureFileOperationError(
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
    throw new SecureFileOperationError(
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
    throw new SecureFileOperationError(
      "invalid",
      "The selected file path is invalid.",
    );
  }
  const basename = segments.pop();
  if (!basename) {
    throw new SecureFileOperationError(
      "invalid",
      "The selected file path is invalid.",
    );
  }
  await assertPinnedNamespace(request, segments);
  return { basename, parentSegments: segments };
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
    const assertNamespace = async (): Promise<void> => {
      await assertPinnedNamespace(request, parentSegments);
    };
    await assertNamespace();
    await recoverSecureFileTransactions(basename);
    await assertNamespace();
    if (request.operation === "recover") {
      return { ok: true, operation: "recover" };
    }
    if (request.operation === "replace") {
      return await replaceSecureFileTransaction(
        request,
        basename,
        assertNamespace,
        hooks,
      );
    }
    const opened = await openVerifiedFile(
      basename,
      request.maxBytes,
      request.targetIdentity,
    );
    try {
      await assertNamespace();
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
    if (error instanceof SecureFileOperationError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return {
      ok: false,
      code: "unavailable",
      message: "The secure file operation could not be completed.",
    };
  }
}

export async function recoverSecureFileOperation(
  value: unknown,
): Promise<boolean> {
  const request = parseSecureFileRequest(value);
  if (!request) return false;
  try {
    const { basename, parentSegments } = await enterVerifiedParent(request);
    await assertPinnedNamespace(request, parentSegments);
    await recoverSecureFileTransactions(basename);
    await assertPinnedNamespace(request, parentSegments);
    return true;
  } catch {
    return false;
  }
}

const parentPort = process.parentPort;
if (parentPort) {
  parentPort.once("message", (event) => {
    const envelope = parseSecureFileWorkerRequest(event.data);
    if (!envelope || envelope.type === "secure-file.result-ack") {
      process.exit(1);
      return;
    }
    const finish = (result: SecureFileWorkerEvent, exitCode: number): void => {
      parentPort.once("message", (acknowledgement) => {
        const ack = parseSecureFileWorkerRequest(acknowledgement.data);
        process.exit(
          ack?.type === "secure-file.result-ack"
              && ack.operationId === envelope.operationId
            ? exitCode
            : 1,
        );
      });
      parentPort.postMessage(result);
    };
    if (envelope.type === "secure-file.recover") {
      void recoverSecureFileOperation(envelope.request).then((ok) => {
        finish({
          type: "secure-file.recovery-result",
          operationId: envelope.operationId,
          ok,
        } satisfies SecureFileWorkerEvent, ok ? 0 : 1);
      });
      return;
    }
    void performSecureFileOperation(envelope.request, {
      onCommitPhase: (phase) => {
        parentPort.postMessage({
          type: "secure-file.commit",
          operationId: envelope.operationId,
          phase,
        } satisfies SecureFileWorkerEvent);
      },
    }).then((result) => {
      finish({
        type: "secure-file.result",
        operationId: envelope.operationId,
        result,
      } satisfies SecureFileWorkerEvent, result.ok ? 0 : 1);
    });
  });
}
