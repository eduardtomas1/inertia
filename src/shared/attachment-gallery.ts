import { z } from "zod";
import { CHAT_ATTACHMENT_MIME_TYPES } from "./attachments";

export const ATTACHMENT_GALLERY_PAGE_SIZE = 60;
export const attachmentGalleryCursorSchema = z.string().min(1).max(4096);
export const attachmentGalleryItemSchema = z.strictObject({
  id: z.string().uuid(), name: z.string().min(1).max(512),
  mimeType: z.enum(CHAT_ATTACHMENT_MIME_TYPES), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const attachmentGalleryResultSchema = z.strictObject({
  kind: z.literal("conversation.attachments"), conversationId: z.string().uuid(),
  attachments: z.array(attachmentGalleryItemSchema).max(ATTACHMENT_GALLERY_PAGE_SIZE),
  olderCursor: attachmentGalleryCursorSchema.nullable(), newerCursor: attachmentGalleryCursorSchema.nullable(),
}).refine((value) => new Set(value.attachments.map((item) => item.id)).size === value.attachments.length);
export type AttachmentGalleryResult = z.infer<typeof attachmentGalleryResultSchema>;
export type AttachmentGalleryItem = z.infer<typeof attachmentGalleryItemSchema>;
