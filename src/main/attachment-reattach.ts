import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { FILE_OPEN_NO_FOLLOW } from "../node/platform-file-open-flags.js";
import type { ConversationAttachmentPreview } from "../node/conversation-attachment-store.js";
import { MAX_ATTACHMENT_BYTES, chatAttachmentStorageExtension } from "../shared/attachments.js";
import type { ChatAttachment } from "../shared/contracts.js";
import {
  parseReattachAttachmentRequest,
  type DesktopAttachmentImportSelection,
  type DesktopWindowContext,
} from "../shared/desktop.js";
import { attachmentImportDocumentFromEvent, type RendererAttachmentImportCoordinator } from "./attachment-import-ipc.js";
import type { AttachmentImportWriter, AttachmentRegistry } from "./attachment-registry.js";
import { ATTACHMENT_COPY_CHUNK_BYTES, privacySafeAttachmentImportError } from "./attachment-selection-import.js";

export const REATTACH_MISSING_ERROR =
  "This file is no longer stored. Attach the original file again.";
export const REATTACH_CHANGED_ERROR =
  "This stored file changed and cannot be re-attached. Attach the original file again.";
/** The store reports a missing content file and altered content alike. */
export const REATTACH_UNREADABLE_ERROR =
  "This file is no longer stored or has changed. Attach the original file again.";
export const REATTACH_UNAVAILABLE_ERROR =
  "Stored attachments are unavailable right now. Try again in a moment.";
const REATTACH_GENERIC_ERROR = "This file could not be re-attached safely.";
const REATTACH_ERRORS: ReadonlySet<string> = new Set([
  REATTACH_MISSING_ERROR,
  REATTACH_CHANGED_ERROR,
  REATTACH_UNREADABLE_ERROR,
  REATTACH_UNAVAILABLE_ERROR,
]);
const STORE_UNSAFE_READ = "Conversation attachment read failed because storage is unsafe.";
const REATTACH_INVALID_ERROR = "Invalid attachment.";

/** The retained-store surface re-attachment needs: metadata-only resolution. */
export interface RetainedAttachmentSource {
  readonly directory: string;
  resolve(id: string, signal?: AbortSignal): Promise<ConversationAttachmentPreview | null>;
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

async function copyRetainedAttachment(
  source: FileHandle,
  destination: FileHandle,
  size: number,
  digest: string,
  signal: AbortSignal,
): Promise<void> {
  const chunk = Buffer.allocUnsafe(ATTACHMENT_COPY_CHUNK_BYTES);
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(chunk, written, bytesRead - written, offset + written);
      if (result.bytesWritten === 0) throw new Error(REATTACH_CHANGED_ERROR);
      written += result.bytesWritten;
    }
    offset += bytesRead;
  }
  signal.throwIfAborted();
  const { bytesRead: overflow } = await source.read(Buffer.allocUnsafe(1), 0, 1, offset);
  if (offset !== size || overflow !== 0 || hash.digest("hex") !== digest) {
    throw new Error(REATTACH_CHANGED_ERROR);
  }
}

/**
 * Copies one retained original into temporary draft storage through the
 * ordinary import path, so type, size, image and capacity validation run
 * again and the renderer only receives an opaque capability id.
 */
export async function importRetainedAttachment(
  registry: Pick<AttachmentRegistry, "importFromWriter">,
  store: RetainedAttachmentSource,
  attachmentId: string,
  signal: AbortSignal,
): Promise<ChatAttachment[]> {
  signal.throwIfAborted();
  let resolved: ConversationAttachmentPreview | null;
  try {
    resolved = await store.resolve(attachmentId, signal);
  } catch (error) {
    signal.throwIfAborted();
    // The isolated store reader verified the record and found it unreadable.
    throw new Error(error instanceof Error && error.message === STORE_UNSAFE_READ
      ? REATTACH_UNREADABLE_ERROR
      : REATTACH_UNAVAILABLE_ERROR);
  }
  if (!resolved) throw new Error(REATTACH_MISSING_ERROR);
  const { attachment, source } = resolved;
  if (
    attachment.id !== attachmentId
    || !source
    || !/^[0-9a-f]{64}$/u.test(source.digest)
    || !Number.isSafeInteger(attachment.size)
    || attachment.size < 1
    || attachment.size > MAX_ATTACHMENT_BYTES
  ) throw new Error(REATTACH_CHANGED_ERROR);
  let canonicalPath: string;
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    const canonicalRoot = await realpath(store.directory);
    info = await lstat(source.path, { bigint: true });
    canonicalPath = await realpath(source.path);
    if (!isContained(canonicalRoot, canonicalPath)) throw new Error(REATTACH_CHANGED_ERROR);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error(REATTACH_MISSING_ERROR);
    throw new Error(REATTACH_CHANGED_ERROR);
  }
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size !== BigInt(attachment.size)
    || basename(canonicalPath) !== `${attachmentId}.${chatAttachmentStorageExtension(attachment.mimeType)}`
  ) throw new Error(REATTACH_CHANGED_ERROR);
  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  const nonBlocking = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
  let file: FileHandle;
  try {
    file = await open(canonicalPath, constants.O_RDONLY | noFollow | nonBlocking);
  } catch (error) {
    throw new Error(errorCode(error) === "ENOENT" ? REATTACH_MISSING_ERROR : REATTACH_CHANGED_ERROR);
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) {
      throw new Error(REATTACH_CHANGED_ERROR);
    }
    const writer: AttachmentImportWriter = {
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      write: async (destination, writeSignal) => {
        await copyRetainedAttachment(file, destination, attachment.size, source.digest, writeSignal);
        const after = await file.stat({ bigint: true });
        if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
          throw new Error(REATTACH_CHANGED_ERROR);
        }
      },
    };
    const imported = await registry.importFromWriter(writer, signal);
    return imported ? [imported] : [];
  } finally {
    await file.close().catch(() => undefined);
  }
}

export function privacySafeReattachError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  if (REATTACH_ERRORS.has(message)) return new Error(message);
  const safe = privacySafeAttachmentImportError(error);
  return safe.message === "Attachments could not be added safely."
    ? new Error(REATTACH_GENERIC_ERROR)
    : safe;
}

export function registerAttachmentReattachIpc(options: {
  ipcMain: Pick<IpcMain, "handle">;
  channel: string;
  assertTrusted(event: IpcMainInvokeEvent, count: number, expected: number): DesktopWindowContext;
  registry(): AttachmentRegistry;
  imports: RendererAttachmentImportCoordinator;
  retained(): Promise<RetainedAttachmentSource> | null;
  /**
   * The chats whose sent messages carry the stored attachment, read from the
   * runtime. When provided, a chat may only re-attach its own files.
   */
  attachmentConversations?(attachmentId: string): Promise<readonly string[]>;
}): void {
  options.ipcMain.handle(options.channel, async (event, ...args): Promise<DesktopAttachmentImportSelection> => {
    const context = options.assertTrusted(event, args.length, 1);
    const request = parseReattachAttachmentRequest(args[0]);
    if (!request) throw new Error(REATTACH_INVALID_ERROR);
    if (context.role === "detached-chat" && context.conversationId !== request.conversationId) {
      throw new Error(REATTACH_INVALID_ERROR);
    }
    if (options.attachmentConversations) {
      let owners: readonly string[];
      try {
        owners = await options.attachmentConversations(request.attachmentId);
      } catch {
        throw new Error(REATTACH_UNAVAILABLE_ERROR);
      }
      if (!owners.includes(request.conversationId)) throw new Error(REATTACH_INVALID_ERROR);
    }
    const access = options.retained();
    let store: RetainedAttachmentSource;
    try {
      if (!access) throw new Error(REATTACH_UNAVAILABLE_ERROR);
      store = await access;
    } catch {
      throw new Error(REATTACH_UNAVAILABLE_ERROR);
    }
    const document = attachmentImportDocumentFromEvent(event);
    const batchId = options.imports.begin(document);
    try {
      const attachments = await options.imports.importSelection(
        document,
        batchId,
        async (signal) => await importRetainedAttachment(options.registry(), store, request.attachmentId, signal),
      );
      if (attachments.length !== 1) throw new Error(REATTACH_GENERIC_ERROR);
      return { batchId, attachments };
    } catch (error) {
      await options.imports.cancel(document, batchId).catch(() => undefined);
      throw privacySafeReattachError(error);
    }
  });
}
