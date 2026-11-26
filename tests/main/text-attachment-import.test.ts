import { describe, expect, it } from "vitest";

import { validateAttachmentImport } from "../../src/main/attachment-import";
import { privacySafeAttachmentImportError } from "../../src/main/attachment-selection-import";
import { MAX_TEXT_ATTACHMENT_BYTES } from "../../src/shared/attachments";

describe("text attachment formats", () => {
  it.each([
    ["notes.txt", "text/plain", Buffer.from("Résumé\r\nUTF-8 text")],
    ["app.log", "", Buffer.from("2026-09-26 INFO ready\n")],
    ["notes.txt", "application/octet-stream", Buffer.from("\ufeffRésumé\r\nUTF-16 text", "utf16le")],
    ["app.log", "text/x-log", Buffer.from("\ufeffINFO ready\n", "utf16le").swap16()],
    ["app.log", "text/plain", Buffer.from("\u001b[31mERROR\u001b[0m: disk full\n")],
    ["notes.txt", "binary/octet-stream", Buffer.from("plain text")],
    ["settings.jsonc", "application/json", Buffer.from('{ // editor settings\n "enabled": true\n}')],
    ["Dockerfile", "", Buffer.from("FROM scratch\n")],
    [".gitignore", "text/plain", Buffer.from("node_modules/\n")],
  ])("imports %s with %s and preserves its bytes", async (name, mimeType, data) => {
    const result = await validateAttachmentImport({ name, mimeType, data });
    expect(result.mimeType).toBe("text/plain");
    expect(result.bytes).toEqual(data);
    expect(result.size).toBe(data.length);
  });

  it("imports a notebook as a Jupyter notebook with its extracted text and preserves its bytes", async () => {
    const data = Buffer.from('{"cells": [{"cell_type": "code", "source": "print(1)"}], "nbformat": 4}\n');
    const result = await validateAttachmentImport({ name: "analysis.ipynb", mimeType: "application/x-ipynb+json", data });
    expect(result).toMatchObject({
      mimeType: "application/x-ipynb+json",
      extension: "ipynb",
      bytes: data,
      size: data.length,
      extractedText: "## Cell 1 (code)\nprint(1)",
      extractedTruncated: false,
    });
    await expect(validateAttachmentImport({
      name: "empty.ipynb",
      mimeType: "application/x-ipynb+json",
      data: Buffer.from('{"cells": [], "nbformat": 4}\n'),
    })).rejects.toThrow("The document contains no readable text.");
  });

  it.each([
    ["notes.txt", "image/png", Buffer.from("text"), /reported type/u],
    ["notes.txt", "", Buffer.from("caf\xe9", "latin1"), /Convert the file to UTF-8/u],
    ["app.log", "", Buffer.from("\x1b]52;c;private\x07"), /terminal control commands/u],
    ["app.log", "", Buffer.alloc(MAX_TEXT_ATTACHMENT_BYTES + 1, 0x61), /50 MiB/u],
  ])("explains why %s cannot be consumed without leaking content", async (name, mimeType, data, message) => {
    try {
      await validateAttachmentImport({ name, mimeType, data });
      expect.fail("Attachment should have been rejected");
    } catch (error) {
      expect(privacySafeAttachmentImportError(error).message).toMatch(message);
      expect(privacySafeAttachmentImportError(error).message).not.toContain("private");
    }
  });
});
