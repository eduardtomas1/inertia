import { createHash } from "node:crypto";

import { shell } from "electron";

import { ConversationAttachmentStore } from "../node/conversation-attachment-store.js";
import { chatAttachmentKind } from "../shared/attachments.js";
import type { ValidatedAttachmentPreview } from "./attachment-registry.js";
import { AttachmentRegistry } from "./attachment-registry.js";
import { validateAttachmentImport } from "./attachment-import.js";

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
): ConversationAttachmentAccess {
  return ConversationAttachmentStore.open(dataDirectory, {
    validate: validateAttachmentImport,
  });
}

export async function resolveAttachmentPreviewResponse(
  temporary: AttachmentRegistry | null,
  retained: ConversationAttachmentAccess | null,
  id: string,
): Promise<Response | null> {
  const temporaryPreview = temporary
    ? await temporary.preview(id).catch(() => null)
    : null;
  const retainedPreview = temporaryPreview
    ? null
    : await retained?.then((store) => store.preview(id));
  const preview: ValidatedAttachmentPreview | null = temporaryPreview
    ?? (retainedPreview
      ? {
          bytes: retainedPreview.bytes,
          mimeType: retainedPreview.attachment.mimeType,
          size: retainedPreview.attachment.size,
        }
      : null);
  if (
    !preview
    || (
      chatAttachmentKind(preview.mimeType) !== "image"
      && preview.mimeType !== "application/pdf"
    )
  ) return null;
  return new Response(new Uint8Array(preview.bytes).buffer, {
    status: 200,
    headers: {
      "Content-Type": preview.mimeType,
      "Content-Length": String(preview.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

export async function openPdfAttachment(
  temporary: AttachmentRegistry,
  retained: ConversationAttachmentAccess | null,
  id: string,
): Promise<void> {
  const temporaryAttachment = await temporary.resolve(id).catch(() => null);
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
