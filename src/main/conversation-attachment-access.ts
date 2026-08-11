import { shell } from "electron";

import { ConversationAttachmentStore } from "../node/conversation-attachment-store.js";
import { chatAttachmentKind } from "../shared/attachments.js";
import type { ValidatedAttachmentPreview } from "./attachment-registry.js";
import { AttachmentRegistry } from "./attachment-registry.js";
import { validateAttachmentImport } from "./attachment-import.js";

export type ConversationAttachmentAccess =
  Promise<ConversationAttachmentStore>;

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
  const attachment = temporaryAttachment
    ?? (await retained?.then((store) => store.preview(id)))?.attachment;
  if (attachment?.mimeType !== "application/pdf") {
    throw new Error("The PDF attachment is unavailable.");
  }
  const openError = await shell.openPath(attachment.path);
  if (openError) {
    throw new Error("The platform PDF app could not open the attachment.");
  }
}
