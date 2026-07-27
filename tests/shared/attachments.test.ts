import { describe, expect, it } from "vitest";

import {
  MAX_CHAT_ATTACHMENTS,
  chatAttachmentKind,
  chatAttachmentMimeTypeForName,
  chatAttachmentTypeLabel,
  clientCommandSchema,
  isPotentialChatAttachment,
} from "../../src/shared/contracts";

describe("chat attachment contract", () => {
  it("classifies only the bounded image and safe-document allowlist", () => {
    expect(chatAttachmentMimeTypeForName("photo.JPEG")).toBe("image/jpeg");
    expect(chatAttachmentMimeTypeForName("readme.markdown")).toBe("text/markdown");
    expect(chatAttachmentMimeTypeForName("payload.svg")).toBeNull();
    expect(chatAttachmentMimeTypeForName("archive.zip")).toBeNull();
    expect(chatAttachmentKind("image/webp")).toBe("image");
    expect(chatAttachmentKind("application/pdf")).toBe("document");
    expect(chatAttachmentTypeLabel("application/json")).toBe("JSON document");
  });

  it("requires extension and declared MIME agreement", () => {
    expect(isPotentialChatAttachment("notes.md", "text/markdown")).toBe(true);
    expect(isPotentialChatAttachment("notes.md", "text/plain")).toBe(true);
    expect(isPotentialChatAttachment("notes.md", "application/pdf")).toBe(false);
    expect(isPotentialChatAttachment("notes.pdf", "image/png")).toBe(false);
  });

  it("accepts bounded document attachments but rejects unsupported and excessive input", () => {
    const attachment = {
      id: crypto.randomUUID(),
      name: "notes.pdf",
      path: "/private/tmp/attachment.pdf",
      mimeType: "application/pdf",
      size: 128,
    };
    const command = {
      type: "message.send",
      requestId: crypto.randomUUID(),
      payload: {
        conversationId: crypto.randomUUID(),
        content: "Review this document.",
        attachments: [attachment],
      },
    };

    expect(clientCommandSchema.safeParse(command).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: {
        ...command.payload,
        attachments: [{ ...attachment, mimeType: "application/msword" }],
      },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: {
        ...command.payload,
        attachments: Array.from({ length: MAX_CHAT_ATTACHMENTS + 1 }, () => attachment),
      },
    }).success).toBe(false);
  });
});
