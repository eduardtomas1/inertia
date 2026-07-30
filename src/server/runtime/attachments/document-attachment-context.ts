import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type { TextItem } from "pdfjs-dist/types/src/display/api";

import type { ChatAttachment } from "../../../shared/contracts";
import type { ResolvedAttachmentPayload } from "./trusted-attachment-resolver";

const MAX_DOCUMENT_CONTEXT_BYTES = 64 * 1024;
export const MAX_DOCUMENT_CONTEXT_TOTAL_BYTES = 96 * 1024;
const MAX_PDF_PAGES = 80;
const PDF_EXTRACTION_TIMEOUT_MS = 12_000;
const require = createRequire(import.meta.url);

export interface DocumentAttachmentContext {
  attachmentId: string;
  label: string;
  content: string;
  truncated: boolean;
}

async function ensurePdfNodePrimitives(): Promise<void> {
  if (
    typeof Reflect.get(globalThis, "DOMMatrix") === "function"
    && typeof Reflect.get(globalThis, "Path2D") === "function"
  ) return;

  const canvas = await import("@napi-rs/canvas");
  if (typeof Reflect.get(globalThis, "DOMMatrix") !== "function") {
    Reflect.set(globalThis, "DOMMatrix", canvas.DOMMatrix);
  }
  if (typeof Reflect.get(globalThis, "Path2D") !== "function") {
    Reflect.set(globalThis, "Path2D", canvas.Path2D);
  }
}

async function loadPdfModule() {
  await ensurePdfNodePrimitives();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
  return pdfjs;
}

function jsonStringContentBytes(value: string): number {
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded.slice(1, -1), "utf8");
}

function boundedUtf8(
  value: string,
  maximumJsonBytes: number,
): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes <= MAX_DOCUMENT_CONTEXT_BYTES
    && jsonStringContentBytes(value) <= maximumJsonBytes
  ) {
    return { value, truncated: false };
  }
  let rawBytes = 0;
  let jsonBytes = 0;
  let bounded = "";
  for (const character of value) {
    const characterRawBytes = Buffer.byteLength(character, "utf8");
    const characterJsonBytes = jsonStringContentBytes(character);
    if (
      rawBytes + characterRawBytes > MAX_DOCUMENT_CONTEXT_BYTES
      || jsonBytes + characterJsonBytes > maximumJsonBytes
    ) break;
    bounded += character;
    rawBytes += characterRawBytes;
    jsonBytes += characterJsonBytes;
  }
  return {
    value: bounded.trimEnd(),
    truncated: true,
  };
}

export function pdfTextItemsToText(items: readonly unknown[]): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    if (
      typeof item !== "object"
      || item === null
      || !("str" in item)
      || typeof (item as Partial<TextItem>).str !== "string"
    ) continue;
    const textItem = item as TextItem;
    line += textItem.str;
    if (textItem.hasEOL) {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines.join("\n").trim();
}

async function extractPdfText(
  attachment: ChatAttachment,
  bytes: Uint8Array,
  maximumJsonBytes: number,
): Promise<{ content: string; truncated: boolean }> {
  const { getDocument } = await loadPdfModule();
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    useWasm: false,
    useWorkerFetch: false,
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        void loadingTask.destroy();
        reject(new Error("PDF text extraction timed out."));
      }, PDF_EXTRACTION_TIMEOUT_MS);
      timeout.unref();
    });
    const document = await Promise.race([loadingTask.promise, timeoutPromise]);
    const pageLimit = Math.min(document.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    let truncated = document.numPages > pageLimit;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await Promise.race([
        document.getPage(pageNumber),
        timeoutPromise,
      ]);
      const textContent = await Promise.race([
        page.getTextContent(),
        timeoutPromise,
      ]);
      const text = pdfTextItemsToText(textContent.items);
      if (text) pages.push(`[Page ${pageNumber}]\n${text}`);
      const bounded = boundedUtf8(pages.join("\n\n"), maximumJsonBytes);
      if (bounded.truncated) {
        truncated = true;
        return { content: bounded.value, truncated };
      }
    }
    const content = pages.join("\n\n").trim();
    if (!content) {
      throw new Error(
        `${attachment.name} has no selectable text. Convert scanned pages to text before attaching it.`,
      );
    }
    return { content, truncated };
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message === "PDF text extraction timed out."
        || error.message.includes("has no selectable text")
      )
    ) throw error;
    throw new Error(`${attachment.name} could not be read as a PDF.`);
  } finally {
    if (timeout) clearTimeout(timeout);
    await loadingTask.destroy().catch(() => undefined);
  }
}

function extractTextDocument(
  attachment: ChatAttachment,
  bytes: Uint8Array,
  maximumJsonBytes: number,
): { content: string; truncated: boolean } {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${attachment.name} is not valid UTF-8 text.`);
  }
  const bounded = boundedUtf8(content.trim(), maximumJsonBytes);
  if (!bounded.value) throw new Error(`${attachment.name} is empty.`);
  return { content: bounded.value, truncated: bounded.truncated };
}

export async function documentAttachmentContexts(
  payloads: readonly ResolvedAttachmentPayload[],
): Promise<DocumentAttachmentContext[]> {
  const documents = payloads.flatMap((payload) =>
    payload.attachment.mimeType.startsWith("image/")
      ? []
      : [payload]);
  if (documents.length === 0) return [];
  const maximumJsonBytes = Math.floor(
    MAX_DOCUMENT_CONTEXT_TOTAL_BYTES / documents.length,
  );
  return await Promise.all(documents.map(async ({ attachment, bytes }) => {
    const extracted = attachment.mimeType === "application/pdf"
      ? await extractPdfText(attachment, bytes, maximumJsonBytes)
      : extractTextDocument(attachment, bytes, maximumJsonBytes);
    return {
      attachmentId: attachment.id,
      label: `${attachment.mimeType === "application/pdf" ? "PDF" : "Document"} · ${attachment.name}`,
      content: extracted.content,
      truncated: extracted.truncated,
    };
  }));
}
