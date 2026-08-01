import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type { TextItem } from "pdfjs-dist/types/src/display/api";

import type { ChatAttachment } from "../../../shared/contracts";
import type { ResolvedAttachmentPayload } from "./trusted-attachment-resolver";
import {
  DocumentExtractionCancelledError,
  DocumentExtractionDeadlineError,
  DocumentExtractionScheduler,
} from "./document-extraction-scheduler";

const MAX_DOCUMENT_CONTEXT_BYTES = 64 * 1024;
export const MAX_DOCUMENT_CONTEXT_TOTAL_BYTES = 96 * 1024;
const MAX_PDF_PAGES = 80;
export const DOCUMENT_EXTRACTION_TURN_TIMEOUT_MS = 12_000;
export const MAX_DOCUMENT_EXTRACTION_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_EXTRACTION_COUNT = 8;
const require = createRequire(import.meta.url);
const sharedExtractionScheduler = new DocumentExtractionScheduler();

export interface DocumentAttachmentContext {
  attachmentId: string;
  label: string;
  content: string;
  truncated: boolean;
}

export interface DocumentAttachmentContextOptions {
  readonly deadlineAt?: number;
  readonly groupId?: string;
  readonly now?: () => number;
  readonly scheduler?: DocumentExtractionScheduler;
  readonly signal?: AbortSignal;
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

interface BoundedTextAccumulator {
  append(value: string): boolean;
  content(): string;
}

function boundedTextAccumulator(
  maximumJsonBytes: number,
): BoundedTextAccumulator {
  const chunks: string[] = [];
  let rawBytes = 0;
  let jsonBytes = 0;
  return {
    append(value) {
      let chunk = "";
      for (const character of value) {
        const characterRawBytes = Buffer.byteLength(character, "utf8");
        const characterJsonBytes = jsonStringContentBytes(character);
        if (
          rawBytes + characterRawBytes > MAX_DOCUMENT_CONTEXT_BYTES
          || jsonBytes + characterJsonBytes > maximumJsonBytes
        ) {
          if (chunk) chunks.push(chunk);
          return false;
        }
        chunk += character;
        rawBytes += characterRawBytes;
        jsonBytes += characterJsonBytes;
      }
      if (chunk) chunks.push(chunk);
      return true;
    },
    content() {
      return chunks.join("").trim();
    },
  };
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
  const accumulator = boundedTextAccumulator(maximumJsonBytes);
  accumulator.append(value);
  return {
    value: accumulator.content(),
    truncated: true,
  };
}

export function pdfTextItemsToText(items: readonly unknown[]): string {
  const accumulator = boundedTextAccumulator(MAX_DOCUMENT_CONTEXT_BYTES);
  for (const item of items) {
    if (
      typeof item !== "object"
      || item === null
      || !("str" in item)
      || typeof (item as Partial<TextItem>).str !== "string"
    ) continue;
    const textItem = item as TextItem;
    if (!accumulator.append(textItem.str)) break;
    if (textItem.hasEOL && !accumulator.append("\n")) break;
  }
  return accumulator.content();
}

async function extractPdfText(
  attachment: ChatAttachment,
  bytes: Uint8Array,
  maximumJsonBytes: number,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<{ content: string; truncated: boolean }> {
  const { getDocument } = await loadPdfModule();
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  const cancel = () => {
    void loadingTask.destroy();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new DocumentExtractionCancelledError();
    const document = await loadingTask.promise;
    const pageLimit = Math.min(document.numPages, MAX_PDF_PAGES);
    const accumulator = boundedTextAccumulator(maximumJsonBytes);
    let hasSelectableText = false;
    let truncated = document.numPages > pageLimit;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      if (signal.aborted) throw new DocumentExtractionCancelledError();
      if (Date.now() >= deadlineAt) {
        throw new DocumentExtractionDeadlineError();
      }
      const page = await document.getPage(pageNumber);
      const reader = page.streamTextContent().getReader();
      let streamDone = false;
      let pageStarted = false;
      try {
        while (!streamDone) {
          if (signal.aborted) throw new DocumentExtractionCancelledError();
          const chunk = await reader.read();
          streamDone = chunk.done;
          if (streamDone) break;
          const items = (chunk.value as { items?: readonly unknown[] }).items;
          if (!Array.isArray(items)) continue;
          for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            if (
              itemIndex % 256 === 0
              && Date.now() >= deadlineAt
            ) {
              void loadingTask.destroy();
              throw new DocumentExtractionDeadlineError();
            }
            const item = items[itemIndex];
            if (
              typeof item !== "object"
              || item === null
              || !("str" in item)
              || typeof (item as Partial<TextItem>).str !== "string"
            ) continue;
            const textItem = item as TextItem;
            let text = textItem.str;
            if (!pageStarted) {
              text = text.trimStart();
              if (!text) continue;
              const prefix = `${hasSelectableText ? "\n\n" : ""}[Page ${pageNumber}]\n`;
              if (!accumulator.append(prefix)) {
                return { content: accumulator.content(), truncated: true };
              }
              pageStarted = true;
              hasSelectableText = true;
            }
            if (!accumulator.append(text)) {
              return { content: accumulator.content(), truncated: true };
            }
            if (textItem.hasEOL && !accumulator.append("\n")) {
              return { content: accumulator.content(), truncated: true };
            }
          }
        }
      } finally {
        if (!streamDone) void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    const content = accumulator.content();
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
        error instanceof DocumentExtractionCancelledError
        || error instanceof DocumentExtractionDeadlineError
        || error.message.includes("has no selectable text")
      )
    ) throw error;
    throw new Error(`${attachment.name} could not be read as a PDF.`);
  } finally {
    signal.removeEventListener("abort", cancel);
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
  options: DocumentAttachmentContextOptions = {},
): Promise<DocumentAttachmentContext[]> {
  const documents = payloads.flatMap((payload) =>
    payload.attachment.mimeType.startsWith("image/")
      ? []
      : [payload]);
  if (documents.length === 0) return [];
  if (
    documents.length > MAX_DOCUMENT_EXTRACTION_COUNT
    || documents.reduce((total, { bytes }) => total + bytes.byteLength, 0)
      > MAX_DOCUMENT_EXTRACTION_INPUT_BYTES
  ) {
    throw new Error("The selected documents exceed the shared extraction budget.");
  }
  if (options.signal?.aborted) {
    throw new DocumentExtractionCancelledError();
  }
  const now = options.now ?? Date.now;
  const deadlineAt = Math.min(
    options.deadlineAt ?? Number.POSITIVE_INFINITY,
    now() + DOCUMENT_EXTRACTION_TURN_TIMEOUT_MS,
  );
  if (deadlineAt <= now()) throw new DocumentExtractionDeadlineError();
  const groupId = options.groupId ?? randomUUID();
  const scheduler = options.scheduler ?? sharedExtractionScheduler;
  const maximumJsonBytes = Math.floor(
    MAX_DOCUMENT_CONTEXT_TOTAL_BYTES / documents.length,
  );
  const extractions = documents.map(async ({ attachment, bytes }) => {
    const extracted = attachment.mimeType === "application/pdf"
      ? await scheduler.schedule({
          groupId,
          weight: bytes.byteLength,
          deadlineAt,
          signal: options.signal,
          operation: (signal) => extractPdfText(
            attachment,
            bytes,
            maximumJsonBytes,
            signal,
            deadlineAt,
          ),
        })
      : extractTextDocument(attachment, bytes, maximumJsonBytes);
    return {
      attachmentId: attachment.id,
      label: `${attachment.mimeType === "application/pdf" ? "PDF" : "Document"} · ${attachment.name}`,
      content: extracted.content,
      truncated: extracted.truncated,
    };
  });
  const settled = await Promise.allSettled(extractions);
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) {
    if (failed.reason instanceof DocumentExtractionDeadlineError) {
      throw new Error("PDF text extraction timed out.");
    }
    throw failed.reason;
  }
  return settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
