import { describe, expect, it } from "vitest";

import { MAX_TEXT_ATTACHMENT_BYTES } from "../../src/shared/attachments";
import { decodeTextAttachment, TextAttachmentError } from "../../src/shared/text-attachment";

describe("text attachment decoding", () => {
  const text = "Résumé 東京 😀\r\n\tsecond line\n";
  it.each([
    Buffer.from(text),
    Buffer.from(`\ufeff${text}`),
    Buffer.from(`\ufeff${text}`, "utf16le"),
    Buffer.from(`\ufeff${text}`, "utf16le").swap16(),
  ])("decodes Unicode without changing whitespace or original bytes", (bytes) => {
    const original = Buffer.from(bytes);
    expect(decodeTextAttachment(bytes)).toBe(text);
    expect(bytes).toEqual(original);
  });

  it("strips log colors while preserving text and markup as inert text", () => {
    expect(decodeTextAttachment(Buffer.from("\x1b[31mERROR\x1b[m <script>x</script>\n")))
      .toBe("ERROR <script>x</script>\n");
  });

  it.each([
    Buffer.from([0xc3, 0x28]), // malformed UTF-8
    Buffer.from([0xff, 0xfe, 0x61]), // incomplete UTF-16 code unit
    Buffer.from([0xff, 0xfe, 0x00, 0xd8]), // unpaired surrogate
    Buffer.from("hello", "utf16le"), // no BOM: do not guess
    Buffer.from("caf\xe9", "latin1"), // ambiguous legacy encoding
    Buffer.from("PK\x03\x04archive"),
    Buffer.from("\0binary"),
    Buffer.from("\x1b[2Jerase display"),
    Buffer.from("\x1b]52;c;secret\x07clipboard"),
    Buffer.from("\u009b31mcontrol"),
    Buffer.from(" \r\n\t"),
  ])("rejects binary, ambiguous encoding and active terminal controls", (bytes) => {
    expect(() => decodeTextAttachment(bytes)).toThrow(TextAttachmentError);
    expect(() => decodeTextAttachment(bytes)).toThrow(/Convert the file to UTF-8/u);
  });

  it("enforces the original encoded byte limit before decoding", () => {
    expect(() => decodeTextAttachment(new Uint8Array(MAX_TEXT_ATTACHMENT_BYTES + 1)))
      .toThrow(/2 MB text limit/u);
  });
});
