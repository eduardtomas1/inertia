import { describe, expect, it } from "vitest";

import {
  validateAttachmentImport,
  validateSelectedAttachmentCount,
  validateSelectedAttachmentOpen,
  validateSelectedAttachmentRead,
  validateSelectedAttachmentStats,
} from "../../src/main/attachment-import";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
} from "../../src/shared/attachments";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
const gif = Buffer.from("GIF89a;", "ascii");
const webp = Buffer.from("RIFF\0\0\0\0WEBP", "binary");
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii");

describe("privileged attachment import validation", () => {
  it("rejects an oversized selection instead of silently truncating it", () => {
    expect(() => validateSelectedAttachmentCount(MAX_CHAT_ATTACHMENTS + 1))
      .toThrow(`Select at most ${MAX_CHAT_ATTACHMENTS} attachments.`);
    expect(() => validateSelectedAttachmentCount(MAX_CHAT_ATTACHMENTS))
      .not.toThrow();
  });

  it("rejects unsafe or oversized chosen-file stats before selected bytes are read", () => {
    expect(() => validateSelectedAttachmentStats([{
      size: 10,
      isFile: false,
      isSymbolicLink: true,
    }])).toThrow(/safe regular file/u);
    expect(() => validateSelectedAttachmentStats([{
      size: MAX_CHAT_ATTACHMENT_BYTES + 1,
      isFile: true,
      isSymbolicLink: false,
    }])).toThrow(/10 MB file limit/u);
    expect(() => validateSelectedAttachmentStats([
      {
        size: MAX_CHAT_ATTACHMENT_TOTAL_BYTES / 2,
        isFile: true,
        isSymbolicLink: false,
      },
      {
        size: MAX_CHAT_ATTACHMENT_TOTAL_BYTES / 2,
        isFile: true,
        isSymbolicLink: false,
      },
      {
        size: 1,
        isFile: true,
        isSymbolicLink: false,
      },
    ])).toThrow(/20 MB turn limit/u);
    expect(() => validateSelectedAttachmentStats([{
      size: 128,
      isFile: true,
      isSymbolicLink: false,
    }])).not.toThrow();
  });

  it("rejects a regular-file replacement between selection and open", () => {
    const selected = {
      dev: 1n,
      ino: 2n,
      isFile: true,
      isSymbolicLink: false,
    };

    expect(() => validateSelectedAttachmentOpen(selected, {
      ...selected,
      ino: 3n,
    })).toThrow(/changed while it was being opened/u);
    expect(() => validateSelectedAttachmentOpen(selected, selected))
      .not.toThrow();
  });

  it("rejects same-size content changes while a selected file is read", () => {
    const before = {
      dev: 1n,
      ino: 2n,
      size: 128n,
      mtimeNs: 3n,
      ctimeNs: 4n,
      isFile: true,
      isSymbolicLink: false,
    };

    expect(() => validateSelectedAttachmentRead(before, {
      ...before,
      mtimeNs: before.mtimeNs + 1n,
      ctimeNs: before.ctimeNs + 1n,
    })).toThrow(/changed while it was being read/u);
    expect(() => validateSelectedAttachmentRead(before, before)).not.toThrow();
  });

  it.each([
    ["preview.png", "image/png", png],
    ["preview.jpg", "image/jpeg", jpeg],
    ["preview.jpeg", "image/jpeg", jpeg],
    ["preview.gif", "image/gif", gif],
    ["preview.webp", "image/webp", webp],
    ["notes.pdf", "application/pdf", pdf],
    ["notes.txt", "text/plain", Buffer.from("Safe notes\n", "utf8")],
    ["notes.md", "text/markdown", Buffer.from("# Safe notes\n", "utf8")],
    ["notes.markdown", "text/plain", Buffer.from("# Safe notes\n", "utf8")],
    ["rows.csv", "text/csv", Buffer.from("name,value\nsafe,1\n", "utf8")],
    ["data.json", "application/json", Buffer.from('{"safe":true}', "utf8")],
  ])("accepts verified %s content", (name, mimeType, data) => {
    const result = validateAttachmentImport({ name, mimeType, data });

    expect(result).toMatchObject({
      displayName: name,
      mimeType: name.endsWith(".markdown") ? "text/markdown" : mimeType,
      size: data.length,
    });
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.bytes).not.toBe(data);
  });

  it("sanitizes display names without retaining a supplied local path", () => {
    expect(validateAttachmentImport({
      name: "/Users/person/private/preview.png",
      mimeType: "image/png",
      data: png,
    }).displayName).toBe("preview.png");
    expect(validateAttachmentImport({
      name: "unsafe\n.png",
      mimeType: "image/png",
      data: png,
    }).displayName).toBe("image.png");
  });

  it("accepts a Linux clipboard PDF with an empty declared MIME after byte verification", () => {
    expect(validateAttachmentImport({
      name: "linux-clipboard.pdf",
      mimeType: "",
      data: pdf,
    })).toMatchObject({
      displayName: "linux-clipboard.pdf",
      mimeType: "application/pdf",
      size: pdf.length,
    });
  });

  it.each([
    { name: "script.svg", mimeType: "image/svg+xml", data: Buffer.from("<svg/>") },
    { name: "archive.zip", mimeType: "application/zip", data: Buffer.from("PK") },
    { name: "preview.png", mimeType: "application/pdf", data: png },
    { name: "notes.pdf", mimeType: "application/pdf", data: png },
    { name: "notes.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.7\n") },
    { name: "notes.json", mimeType: "application/json", data: Buffer.from("{bad}") },
    { name: "notes.txt", mimeType: "text/plain", data: Buffer.from([0xff, 0xfe]) },
    { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("safe\0unsafe") },
    { name: "empty.txt", mimeType: "text/plain", data: Buffer.alloc(0) },
    {
      name: "large.png",
      mimeType: "image/png",
      data: Buffer.alloc(MAX_CHAT_ATTACHMENT_BYTES + 1),
    },
  ])("rejects malformed or unsupported imports %#", (candidate) => {
    expect(() => validateAttachmentImport(candidate)).toThrow();
  });
});
