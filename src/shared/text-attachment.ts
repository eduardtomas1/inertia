import { MAX_TEXT_ATTACHMENT_BYTES } from "./attachments";

export const TEXT_ATTACHMENT_CONTENT_ERROR =
  "Text attachments must contain readable UTF-8 or BOM-marked UTF-16 text, without binary data or terminal control commands. Convert the file to UTF-8 and try again.";
export const TEXT_ATTACHMENT_SIZE_ERROR =
  "Text attachments exceed the 2 MB text limit. Attach a smaller excerpt.";
export const UNSUPPORTED_ATTACHMENT_TYPE_ERROR =
  "Unsupported attachment type. Attach images, PDF, Excel, or supported text/source/configuration files. Extract archives and convert other binary documents first.";
export const ATTACHMENT_MIME_MISMATCH_ERROR =
  "The attachment's reported type does not match its filename. Export it in a supported format and try again.";

export class TextAttachmentError extends Error {
  constructor(readonly code: "text-content" | "text-size") {
    super(code === "text-size" ? TEXT_ATTACHMENT_SIZE_ERROR : TEXT_ATTACHMENT_CONTENT_ERROR);
  }
}

export function decodeTextAttachment(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new TextAttachmentError("text-size");
  }
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe
    ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff
      ? "utf-16be"
      : "utf-8";
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new TextAttachmentError("text-content");
  }
  text = text.replace(/\x1b\[[0-9;:]*m/gu, "");
  if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text) || !text.trim()) {
    throw new TextAttachmentError("text-content");
  }
  return text;
}
