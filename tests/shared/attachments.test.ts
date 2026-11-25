import { describe, expect, it } from "vitest";

import {
  isExtractedDocumentAttachmentMimeType,
  storedAttachmentTypeMatchesName,
} from "../../src/shared/attachments";
import {
  MAX_ATTACHMENT_COUNT,
  chatAttachmentKind,
  safeChatAttachmentMimeTypeForName as chatAttachmentMimeTypeForName,
  chatAttachmentTypeLabel,
  clientCommandSchema,
  isPotentialChatAttachment,
} from "../../src/shared/contracts";

describe("chat attachment contract", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "treats prototype property names as opaque files: %s", (key) => {
      expect(chatAttachmentMimeTypeForName(`file.${key}`)).toBe("application/octet-stream");
      expect(isPotentialChatAttachment(`file.${key}`, "application/octet-stream")).toBe(true);
    },
  );
  it("classifies preview formats and keeps other files opaque", () => {
    expect(chatAttachmentMimeTypeForName("photo.JPEG")).toBe("image/jpeg");
    expect(chatAttachmentMimeTypeForName("readme.markdown")).toBe("text/markdown");
    expect(chatAttachmentMimeTypeForName("payload.svg")).toBe("application/octet-stream");
    expect(chatAttachmentMimeTypeForName("archive.zip")).toBe("application/octet-stream");
    expect(chatAttachmentKind("image/webp")).toBe("image");
    expect(chatAttachmentKind("application/pdf")).toBe("document");
    expect(chatAttachmentTypeLabel("application/json")).toBe("JSON document");
  });

  it("classifies Word, PowerPoint, RTF, OpenDocument, notebook and EPUB files for extraction", () => {
    const expected = {
      "report.DOCX": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Word document"],
      "deck.pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "PowerPoint presentation"],
      "letter.rtf": ["application/rtf", "RTF document"],
      "essay.odt": ["application/vnd.oasis.opendocument.text", "OpenDocument text"],
      "ledger.ods": ["application/vnd.oasis.opendocument.spreadsheet", "OpenDocument spreadsheet"],
      "talk.odp": ["application/vnd.oasis.opendocument.presentation", "OpenDocument presentation"],
      "analysis.ipynb": ["application/x-ipynb+json", "Jupyter notebook"],
      "novel.epub": ["application/epub+zip", "EPUB book"],
    } as const;
    for (const [name, [mimeType, label]] of Object.entries(expected)) {
      expect(chatAttachmentMimeTypeForName(name), name).toBe(mimeType);
      expect(isExtractedDocumentAttachmentMimeType(mimeType)).toBe(true);
      expect(chatAttachmentKind(mimeType)).toBe("document");
      expect(chatAttachmentTypeLabel(mimeType)).toBe(label);
      expect(isPotentialChatAttachment(name, mimeType)).toBe(true);
      expect(isPotentialChatAttachment(name, "")).toBe(true);
      expect(isPotentialChatAttachment(name, "image/png")).toBe(false);
    }
    expect(isExtractedDocumentAttachmentMimeType("application/pdf")).toBe(false);
    expect(isPotentialChatAttachment("report.docx", "application/zip")).toBe(true);
    expect(isPotentialChatAttachment("letter.rtf", "text/rtf")).toBe(true);
    expect(isPotentialChatAttachment("analysis.ipynb", "application/json")).toBe(true);
    expect(isPotentialChatAttachment("report.docx", "application/pdf")).toBe(false);
  });

  it("keeps attachments stored before these types existed readable", () => {
    expect(storedAttachmentTypeMatchesName("analysis.ipynb", "text/plain")).toBe(true);
    expect(storedAttachmentTypeMatchesName("report.docx", "application/octet-stream")).toBe(true);
    expect(storedAttachmentTypeMatchesName("report.docx", "text/plain")).toBe(false);
    expect(storedAttachmentTypeMatchesName("notes.txt", "application/x-ipynb+json")).toBe(false);
  });

  it("requires extension and declared MIME agreement", () => {
    expect(isPotentialChatAttachment("notes.md", "text/markdown")).toBe(true);
    expect(isPotentialChatAttachment("notes.md", "text/plain")).toBe(true);
    expect(isPotentialChatAttachment("notes.md", "application/pdf")).toBe(false);
    expect(isPotentialChatAttachment("notes.pdf", "image/png")).toBe(false);
  });

  it("accepts plain-text source, markup and configuration names as text beside the pinned lookup", () => {
    for (const name of ["config.yaml", "main.ts", "index.html", "query.sql", "Dockerfile.patch", "app.log", "rows.tsv", "Dockerfile", "Makefile", ".gitignore", "settings.jsonc"]) {
      expect(chatAttachmentMimeTypeForName(name), name).toBe("text/plain");
    }
    // The lookup migration 56 pins is unchanged; the names it knows keep their own type.
    expect(chatAttachmentMimeTypeForName("notes.txt")).toBe("text/plain");
    expect(chatAttachmentMimeTypeForName("data.json")).toBe("application/json");
    // Other user-selected files are stored as opaque bytes, without an active preview.
    for (const name of ["secrets.env", "server.pem", "id.key", "logo.svg", "app.exe", "archive.tar", "config.yaml."]) {
      expect(chatAttachmentMimeTypeForName(name), name).toBe("application/octet-stream");
    }
    // Platforms declare these files with their own types, or none at all.
    expect(isPotentialChatAttachment("config.yaml", "application/x-yaml")).toBe(true);
    expect(isPotentialChatAttachment("config.yaml", "text/yaml")).toBe(true);
    expect(isPotentialChatAttachment("main.ts", "video/mp2t")).toBe(true);
    expect(isPotentialChatAttachment("script.py", "text/x-python")).toBe(true);
    expect(isPotentialChatAttachment("script.py", "")).toBe(true);
    expect(isPotentialChatAttachment("script.py", "application/octet-stream")).toBe(true);
    expect(isPotentialChatAttachment("notes.txt", " BINARY/OCTET-STREAM; charset=utf-16 ")).toBe(true);
    expect(isPotentialChatAttachment("app.log", "application/unknown")).toBe(true);
    expect(isPotentialChatAttachment("settings.jsonc", "application/json")).toBe(true);
    expect(isPotentialChatAttachment("Dockerfile", "")).toBe(true);
    expect(isPotentialChatAttachment("notebook.ipynb", "application/x-ipynb+json")).toBe(true);
    expect(isPotentialChatAttachment("main.dart", "application/vnd.dart")).toBe(true);
    expect(isPotentialChatAttachment("view.tsx", "application/x-tiled-tsx")).toBe(true);
    expect(isPotentialChatAttachment("page.mdx", "application/x-genesis-32x-rom")).toBe(true);
    expect(isPotentialChatAttachment("main.ts", "video/vnd.dlna.mpeg-tts")).toBe(true);
    expect(isPotentialChatAttachment("notes.txt", "application/x-ipynb+json")).toBe(false);
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
        attachments: Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, () => attachment),
      },
    }).success).toBe(false);
  });
});
