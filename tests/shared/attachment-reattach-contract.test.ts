import { describe, expect, it } from "vitest";

import {
  CONVERSATION_ATTACHMENT_GALLERY_FILTERS,
  conversationAttachmentGalleryCategory,
  filterConversationAttachmentGallery,
  type ConversationAttachmentGalleryItem,
} from "../../src/shared/conversation-attachment-gallery";
import { ACCEPTED_ATTACHMENT_MIME_TYPES } from "../../src/shared/attachments";
import { parseReattachAttachmentRequest } from "../../src/shared/desktop";

const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const attachmentId = "11111111-1111-4111-8111-111111111111";

describe("re-attach request contract", () => {
  it("accepts exactly one conversation and one stored attachment identity", () => {
    expect(parseReattachAttachmentRequest({ conversationId, attachmentId })).toEqual({ conversationId, attachmentId });
  });

  it.each([
    null,
    [],
    "attachment",
    {},
    { conversationId },
    { attachmentId },
    { conversationId, attachmentId, path: "/tmp/x" },
    { conversationId, attachmentId: `${attachmentId}/../x` },
    { conversationId: "chat", attachmentId },
    { conversationId, attachmentId: 7 },
  ])("rejects %j", (value) => {
    expect(parseReattachAttachmentRequest(value)).toBeNull();
  });
});

describe("attachment gallery filters", () => {
  it("places every accepted type in exactly one category", () => {
    const categories = ACCEPTED_ATTACHMENT_MIME_TYPES.map(conversationAttachmentGalleryCategory);
    expect(new Set(categories)).toEqual(new Set(["images", "documents", "text"]));
    expect(CONVERSATION_ATTACHMENT_GALLERY_FILTERS).toEqual(["all", "images", "documents", "text"]);
    expect(conversationAttachmentGalleryCategory("image/webp")).toBe("images");
    expect(conversationAttachmentGalleryCategory("application/json")).toBe("text");
    expect(conversationAttachmentGalleryCategory("text/csv")).toBe("text");
    expect(conversationAttachmentGalleryCategory("application/pdf")).toBe("documents");
    expect(conversationAttachmentGalleryCategory("application/vnd.ms-excel")).toBe("documents");
    expect(conversationAttachmentGalleryCategory("application/octet-stream")).toBe("documents");
  });

  it("keeps the newest-first order and the same array for All", () => {
    const items: ConversationAttachmentGalleryItem[] = [
      { id: "a", name: "a.png", mimeType: "image/png", size: 1 },
      { id: "b", name: "b.txt", mimeType: "text/plain", size: 1 },
      { id: "c", name: "c.gif", mimeType: "image/gif", size: 1 },
    ];
    expect(filterConversationAttachmentGallery(items, "all")).toBe(items);
    expect(filterConversationAttachmentGallery(items, "images").map(({ id }) => id)).toEqual(["a", "c"]);
    expect(filterConversationAttachmentGallery(items, "text").map(({ id }) => id)).toEqual(["b"]);
    expect(filterConversationAttachmentGallery(items, "documents")).toEqual([]);
  });
});
