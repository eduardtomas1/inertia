import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  type FileHandle,
} from "node:fs/promises";
import { basename } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from
  "../node/platform-file-open-flags.js";
import type { ChatAttachment } from "../shared/contracts.js";
import type { AttachmentPickerMode } from "../shared/desktop.js";
import {
  validateAttachmentPickerName,
  validateSelectedAttachmentCount,
  validateSelectedAttachmentOpen,
  validateSelectedAttachmentRead,
  validateSelectedAttachmentStats,
  type SelectedAttachmentReadSnapshot,
} from "./attachment-import.js";
import type {
  AttachmentImportWriter,
  AttachmentRegistry,
} from "./attachment-registry.js";

export const ATTACHMENT_COPY_CHUNK_BYTES = 64 * 1024;

interface SelectedAttachment {
  readonly path: string;
  readonly name: string;
  readonly snapshot: SelectedAttachmentReadSnapshot;
}

const SAFE_ATTACHMENT_ERRORS = new Set([
  "A selected attachment changed while it was being opened.",
  "A selected attachment changed while it was being read.",
  "A selected attachment is empty or exceeds the 10 MB file limit.",
  "Attachment content does not match its safe file type.",
  "Attachment import did not complete.",
  "Attachment import is busy. Try again in a moment.",
  "Attachment import was cancelled.",
  "Attachment validation is at bounded capacity.",
  "Attachment validation request could not be delivered.",
  "Attachment validation returned a result before startup.",
  "Attachment validation returned an invalid result.",
  "Attachment validation timed out.",
  "Attachment validation utility could not be started.",
  "Attachment validation utility is unavailable.",
  "Attachment validation utility shutdown is unconfirmed.",
  "Attachment validation utility stopped before replying.",
  "Attachment validation utility stopped unexpectedly.",
  "Attachments exceed the 20 MB turn limit.",
  "Follow-up attachments must be images.",
  "Invalid attachment.",
  "Invalid attachments.",
  "Selected attachments exceed the 20 MB turn limit.",
  "Temporary attachment storage could not be verified safely.",
  "Temporary attachment storage is no longer available.",
  "Temporary attachment storage is full. Remove an attachment and try again.",
  "The selected attachment could not be staged safely.",
  "The selected attachment is not a safe regular file.",
]);
const SAFE_ATTACHMENT_COUNT_ERROR = /^Select at most \d+ attachments\.$/u;

export function privacySafeAttachmentImportError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  return SAFE_ATTACHMENT_ERRORS.has(message)
    || SAFE_ATTACHMENT_COUNT_ERROR.test(message)
    ? new Error(message)
    : new Error("Attachments could not be added safely.");
}

function readSnapshot(
  info: BigIntStats,
): SelectedAttachmentReadSnapshot {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    isFile: info.isFile(),
    isSymbolicLink: info.isSymbolicLink(),
  };
}

async function writeComplete(
  destination: FileHandle,
  bytes: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await destination.write(
      bytes,
      written,
      length - written,
      position + written,
    );
    if (result.bytesWritten === 0) {
      throw new Error("The selected attachment could not be staged safely.");
    }
    written += result.bytesWritten;
  }
}

export async function copySelectedAttachment(
  source: FileHandle,
  destination: FileHandle,
  snapshot: SelectedAttachmentReadSnapshot,
  signal: AbortSignal,
): Promise<void> {
  const chunk = Buffer.allocUnsafe(ATTACHMENT_COPY_CHUNK_BYTES);
  let offset = 0;
  while (offset < Number(snapshot.size)) {
    signal.throwIfAborted();
    const requested = Math.min(chunk.length, Number(snapshot.size) - offset);
    const { bytesRead } = await source.read(chunk, 0, requested, offset);
    if (bytesRead === 0) break;
    await writeComplete(destination, chunk, bytesRead, offset);
    offset += bytesRead;
  }
  signal.throwIfAborted();
  const overflow = Buffer.allocUnsafe(1);
  const { bytesRead: overflowBytes } = await source.read(
    overflow,
    0,
    1,
    offset,
  );
  if (offset !== Number(snapshot.size) || overflowBytes !== 0) {
    throw new Error("A selected attachment changed while it was being read.");
  }
  const after = await source.stat({ bigint: true });
  validateSelectedAttachmentRead(snapshot, readSnapshot(after));
}

async function inspectSelections(
  paths: readonly string[],
  mode: AttachmentPickerMode,
  signal: AbortSignal,
): Promise<SelectedAttachment[]> {
  validateSelectedAttachmentCount(paths.length);
  const selections: SelectedAttachment[] = [];
  for (const path of paths) {
    signal.throwIfAborted();
    const name = basename(path);
    validateAttachmentPickerName(mode, name);
    const info = await lstat(path, { bigint: true });
    selections.push({ path, name, snapshot: readSnapshot(info) });
  }
  validateSelectedAttachmentStats(selections.map(({ snapshot }) => ({
    size: Number(snapshot.size),
    isFile: snapshot.isFile,
    isSymbolicLink: snapshot.isSymbolicLink,
  })));
  return selections;
}

export async function importSelectedAttachmentPaths(
  registry: Pick<AttachmentRegistry, "importFromWriter" | "rollback">,
  paths: readonly string[],
  mode: AttachmentPickerMode,
  signal: AbortSignal,
): Promise<ChatAttachment[]> {
  const selections = await inspectSelections(paths, mode, signal);
  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  const nonBlocking = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
  const batchDigests = new Set<string>();
  const imported: ChatAttachment[] = [];
  try {
    for (const selected of selections) {
      signal.throwIfAborted();
      const source = await open(
        selected.path,
        constants.O_RDONLY | noFollow | nonBlocking,
      );
      try {
        const opened = await source.stat({ bigint: true });
        const openedSnapshot = readSnapshot(opened);
        validateSelectedAttachmentOpen(selected.snapshot, openedSnapshot);
        validateSelectedAttachmentRead(selected.snapshot, openedSnapshot);
        const writer: AttachmentImportWriter = {
          name: selected.name,
          mimeType: "",
          size: Number(opened.size),
          write: async (destination, operationSignal) => {
            await copySelectedAttachment(
              source,
              destination,
              openedSnapshot,
              operationSignal,
            );
          },
        };
        const attachment = await registry.importFromWriter(
          writer,
          signal,
          batchDigests,
        );
        if (attachment) imported.push(attachment);
      } finally {
        await source.close().catch(() => undefined);
      }
    }
    return imported;
  } catch (error) {
    await Promise.all(imported.map(async ({ id }) =>
      await registry.rollback(id)));
    throw error;
  }
}
