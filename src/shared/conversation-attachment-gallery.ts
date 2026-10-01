export const CONVERSATION_ATTACHMENT_GALLERY_LIMIT = 60;

export interface ConversationAttachmentGalleryItem {
  id: string;
  name: string;
  mimeType: ChatAttachmentMimeType;
  size: number;
}

export function isConversationAttachmentGallery(value: unknown): value is ConversationAttachmentGalleryItem[] {
  if (!Array.isArray(value) || value.length > CONVERSATION_ATTACHMENT_GALLERY_LIMIT) return false;
  const ids = new Set<string>();
  return value.every((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).length !== 4
      || typeof item.id !== "string" || !item.id || item.id.length > 200
      || typeof item.name !== "string" || !item.name || item.name.length > 1_024
      || typeof item.mimeType !== "string" || !(ACCEPTED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(item.mimeType)
      || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0
      || ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
}
import { ACCEPTED_ATTACHMENT_MIME_TYPES, type ChatAttachmentMimeType } from "./attachments";
