import { TextAttachmentError } from "../shared/text-attachment.js";

/** Validate readable text incrementally without keeping the document in memory. */
export function attachmentTextValidator(): { chunk(bytes: Buffer): void; finish(): void } {
  let decoder: TextDecoder | undefined;
  let pending = "";
  let readable = false;
  const inspect = (text: string, final = false): void => {
    text = pending + text;
    pending = "";
    if (!final) {
      const escape = text.lastIndexOf("\x1b");
      if (escape >= 0 && /^\x1b(?:\[[0-9;:]*)?$/u.test(text.slice(escape))) {
        pending = text.slice(escape);
        text = text.slice(0, escape);
        if (pending.length > 1024) throw new TextAttachmentError("text-content");
      }
    }
    text = text.replace(/\x1b\[[0-9;:]*m/gu, "");
    if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text)) throw new TextAttachmentError("text-content");
    readable ||= text.trim().length > 0;
  };
  return {
    chunk(bytes) {
      decoder ??= new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8", { fatal: true });
      try { inspect(decoder.decode(bytes, { stream: true })); }
      catch { throw new TextAttachmentError("text-content"); }
    },
    finish() {
      try { inspect(decoder?.decode() ?? "", true); }
      catch { throw new TextAttachmentError("text-content"); }
      if (!readable) throw new TextAttachmentError("text-content");
    },
  };
}
