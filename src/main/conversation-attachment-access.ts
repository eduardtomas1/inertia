import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";

import { shell } from "electron";

import { ConversationAttachmentStore } from "../node/conversation-attachment-store.js";
import type {
  ConversationAttachmentStoreAnyOperationRunner,
  ConversationAttachmentStoreAuthority,
} from "../node/conversation-attachment-store-child.js";
import { isExtractedDocumentAttachmentMimeType } from "../shared/attachments.js";
import type {
  AttachmentImportDocumentExtractExecution,
  AttachmentImportDocumentExtractOperation,
} from "./attachment-import-file.js";
import type { ValidatedAttachmentPreview } from "./attachment-registry.js";
import { AttachmentRegistry } from "./attachment-registry.js";
import type { AttachmentPreviewScopePolicy } from "./attachment-window-scope.js";

export type ConversationAttachmentAccess =
  Promise<ConversationAttachmentStore>;

const MAX_RETAINED_PDF_COPIES = 8;
interface RetainedPdfCopy {
  readonly copyId: string;
  readonly digest: string;
}

interface RetainedPdfCopyCache {
  readonly copies: Map<string, RetainedPdfCopy>;
  tail: Promise<void>;
}

const retainedPdfCopyCaches = new WeakMap<
  AttachmentRegistry,
  RetainedPdfCopyCache
>();

function retainedPdfCopyCache(
  temporary: AttachmentRegistry,
): RetainedPdfCopyCache {
  const existing = retainedPdfCopyCaches.get(temporary);
  if (existing) return existing;
  const created: RetainedPdfCopyCache = {
    copies: new Map<string, RetainedPdfCopy>(),
    tail: Promise.resolve(),
  };
  retainedPdfCopyCaches.set(temporary, created);
  return created;
}

async function serializeRetainedPdfOpen<T>(
  cache: RetainedPdfCopyCache,
  operation: (copies: Map<string, RetainedPdfCopy>) => Promise<T>,
): Promise<T> {
  const previous = cache.tail;
  let unlock!: () => void;
  cache.tail = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await previous;
  try {
    return await operation(cache.copies);
  } finally {
    unlock();
  }
}

export function openConversationAttachments(
  dataDirectory: string,
  operationRunner: ConversationAttachmentStoreAnyOperationRunner,
): ConversationAttachmentAccess {
  return ConversationAttachmentStore.open(dataDirectory, {
    operationRunner,
    readOperationRunner: operationRunner,
  });
}

export async function conversationAttachmentStoreAuthority(
  store: ConversationAttachmentStore,
): Promise<ConversationAttachmentStoreAuthority> {
  const entry = await lstat(store.directory, { bigint: true });
  return {
    root: store.directory,
    dev: String(entry.dev),
    ino: String(entry.ino),
    uid: process.platform === "win32" ? null : String(entry.uid),
  };
}

export async function closeConversationAttachmentAccess(
  retained: ConversationAttachmentAccess | null,
): Promise<void> {
  await retained?.then((store) => store.close());
}

export type AttachmentDocumentPreviewExtractor = (
  operation: AttachmentImportDocumentExtractOperation,
  signal?: AbortSignal,
) => AttachmentImportDocumentExtractExecution;

export async function resolveAttachmentPreviewResponse(
  temporary: AttachmentRegistry | null,
  retained: ConversationAttachmentAccess | null,
  id: string,
  extractDocument?: AttachmentDocumentPreviewExtractor,
  signal?: AbortSignal,
  scopePolicy?: AttachmentPreviewScopePolicy,
): Promise<Response | null> {
  const allowTemporary = scopePolicy?.allowTemporary
    ? scopePolicy.allowTemporary()
    : true;
  const temporaryPreview = temporary && allowTemporary
    ? await temporary.preview(id, signal).catch(() => null)
    : null;
  let retainedPreview = null;
  if (!temporaryPreview && retained) {
    const allowRetained = scopePolicy?.allowRetained
      ? await scopePolicy.allowRetained()
      : true;
    if (allowRetained) {
      retainedPreview = await retained.then((store) => store.preview(id, signal)).catch(() => null);
    }
  }
  let preview: ValidatedAttachmentPreview | null = temporaryPreview;
  if (!preview && retainedPreview) {
    if (isExtractedDocumentAttachmentMimeType(retainedPreview.attachment.mimeType)) {
      if (!extractDocument) return null;
      const execution = extractDocument({
        mimeType: retainedPreview.attachment.mimeType,
        bytes: retainedPreview.bytes,
      }, signal);
      let extracted: { readonly text: string; readonly truncated: boolean } | null = null;
      try {
        extracted = await execution.result;
      } catch {
        await execution.stopped.catch(() => undefined);
        return null;
      }
      await execution.stopped.catch(() => undefined);
      preview = {
        bytes: Buffer.from(extracted.text, "utf8"),
        mimeType: retainedPreview.attachment.mimeType,
        size: retainedPreview.attachment.size,
        truncated: extracted.truncated,
      };
    } else {
      preview = {
        bytes: retainedPreview.bytes,
        mimeType: retainedPreview.attachment.mimeType,
        size: retainedPreview.attachment.size,
      };
    }
  }
  if (!preview) return null;
  const truncated = preview.truncated ?? (preview.bytes.byteLength < preview.size);
  return new Response(new Uint8Array(preview.bytes).buffer, {
    status: 200,
    headers: {
      "Content-Type": preview.mimeType,
      "Content-Length": String(preview.bytes.byteLength),
      "X-Attachment-Size": String(preview.size),
      "X-Attachment-Truncated": String(truncated),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

export async function openPdfAttachment(
  temporary: AttachmentRegistry,
  retained: ConversationAttachmentAccess | null,
  id: string,
  scopePolicy?: AttachmentPreviewScopePolicy,
): Promise<void> {
  const allowTemporary = scopePolicy?.allowTemporary
    ? scopePolicy.allowTemporary()
    : true;
  const temporaryAttachment = allowTemporary
    ? await temporary.resolve(id).catch(() => null)
    : null;
  if (temporaryAttachment) {
    if (temporaryAttachment.mimeType !== "application/pdf") {
      throw new Error("The PDF attachment is unavailable.");
    }
    const openError = await shell.openPath(temporaryAttachment.path);
    if (openError) {
      throw new Error("The platform PDF app could not open the attachment.");
    }
    return;
  }
  const allowRetained = scopePolicy?.allowRetained
    ? await scopePolicy.allowRetained()
    : true;
  if (!allowRetained) {
    throw new Error("The PDF attachment is unavailable.");
  }
  const retainedPreview = await retained?.then((store) => store.preview(id));
  if (retainedPreview?.attachment.mimeType !== "application/pdf") {
    throw new Error("The PDF attachment is unavailable.");
  }
  const digest = createHash("sha256")
    .update(retainedPreview.bytes)
    .digest("hex");
  await serializeRetainedPdfOpen(
    retainedPdfCopyCache(temporary),
    async (copies) => {
      const cached = copies.get(id);
      let copyId = cached?.digest === digest ? cached.copyId : undefined;
      if (cached && !copyId) {
        copies.delete(id);
        await temporary.release(cached.copyId).catch(() => undefined);
      }
      let copy = copyId
        ? await temporary.resolve(copyId).catch(() => null)
        : null;
      if (copy?.mimeType !== "application/pdf") {
        if (copyId) {
          copies.delete(id);
          await temporary.release(copyId).catch(() => undefined);
        }
        while (copies.size >= MAX_RETAINED_PDF_COPIES) {
          const oldest = copies.entries().next().value as
            | [string, RetainedPdfCopy]
            | undefined;
          if (!oldest) break;
          copies.delete(oldest[0]);
          await temporary.release(oldest[1].copyId).catch(() => undefined);
        }
        const [imported] = await temporary.import([{
          name: retainedPreview.attachment.name,
          mimeType: retainedPreview.attachment.mimeType,
          data: retainedPreview.bytes,
        }]);
        copyId = imported?.id;
        copy = copyId
          ? await temporary.resolve(copyId).catch(() => null)
          : null;
        if (!copyId || copy?.mimeType !== "application/pdf") {
          if (copyId) await temporary.release(copyId).catch(() => undefined);
          throw new Error("The validated PDF copy is unavailable.");
        }
        copies.set(id, { copyId, digest });
      } else if (cached) {
        copies.delete(id);
        copies.set(id, cached);
      }
      const openError = await shell.openPath(copy.path);
      if (!openError) return;
      copies.delete(id);
      if (copyId) await temporary.release(copyId).catch(() => undefined);
      throw new Error("The platform PDF app could not open the attachment.");
    },
  );
}
