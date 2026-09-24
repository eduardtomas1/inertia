import { describe, expect, it } from "vitest";

import {
  MAX_CHAT_ATTACHMENTS,
  chatAttachmentKind,
  safeChatAttachmentMimeTypeForName as chatAttachmentMimeTypeForName,
  chatAttachmentTypeLabel,
  clientCommandSchema,
  isPotentialChatAttachment,
} from "../../src/shared/contracts";

describe("chat attachment contract", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "rejects inherited MIME lookup key %s", (key) => {
      expect(chatAttachmentMimeTypeForName(`file.${key}`)).toBeNull();
      expect(isPotentialChatAttachment(`file.${key}`, "application/octet-stream")).toBe(false);
    },
  );
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

  it("accepts plain-text source, markup and configuration names as text beside the pinned lookup", () => {
    for (const name of ["config.yaml", "main.ts", "index.html", "query.sql", "Dockerfile.patch", "app.log", "rows.tsv"]) {
      expect(chatAttachmentMimeTypeForName(name), name).toBe("text/plain");
    }
    // The lookup migration 56 pins is unchanged; the names it knows keep their own type.
    expect(chatAttachmentMimeTypeForName("notes.txt")).toBe("text/plain");
    expect(chatAttachmentMimeTypeForName("data.json")).toBe("application/json");
    // Credentials, scriptable images and binary containers stay out.
    for (const name of ["secrets.env", "server.pem", "id.key", "logo.svg", "app.exe", "archive.tar", "config.yaml."]) {
      expect(chatAttachmentMimeTypeForName(name), name).toBeNull();
    }
    // Platforms declare these files with their own types, or none at all.
    expect(isPotentialChatAttachment("config.yaml", "application/x-yaml")).toBe(true);
    expect(isPotentialChatAttachment("config.yaml", "text/yaml")).toBe(true);
    expect(isPotentialChatAttachment("main.ts", "video/mp2t")).toBe(true);
    expect(isPotentialChatAttachment("script.py", "text/x-python")).toBe(true);
    expect(isPotentialChatAttachment("script.py", "")).toBe(true);
    expect(isPotentialChatAttachment("script.py", "application/octet-stream")).toBe(true);
    expect(isPotentialChatAttachment("index.html", "image/png")).toBe(false);
    expect(isPotentialChatAttachment("index.html", "application/pdf")).toBe(false);
    expect(isPotentialChatAttachment("index.html", "application/zip")).toBe(false);
    // The plain-text declared set does not widen the pinned names.
    expect(isPotentialChatAttachment("notes.txt", "application/x-yaml")).toBe(false);
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
