import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type { TextItem } from "pdfjs-dist/types/src/display/api";

import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentKind,
} from "../../../shared/attachments";
import type { ChatAttachment } from "../../../shared/contracts";
import type { ResolvedAttachmentPayload } from "./trusted-attachment-resolver";
import {
  DocumentExtractionCancelledError,
  DocumentExtractionDeadlineError,
  DocumentExtractionInitializationError,
  DocumentExtractionScheduler,
} from "./document-extraction-scheduler";
import {
  type PrivateGeneratedAttachmentStore,
} from "./private-generated-attachments";

const MAX_DOCUMENT_CONTEXT_BYTES = 64 * 1024;
export const MAX_DOCUMENT_CONTEXT_TOTAL_BYTES = 96 * 1024;
const MAX_PDF_PAGES = 80;
const MAX_RASTER_DIMENSION = 1_600;
const MAX_PDF_SOURCE_IMAGE_PIXELS = 16_000_000;
const MAX_PDF_SOURCE_RGBA_BYTES = MAX_PDF_SOURCE_IMAGE_PIXELS * 4;
const MAX_RASTER_PIXELS = 2_500_000;
const MAX_RASTER_RGBA_BYTES = MAX_RASTER_PIXELS * 4;
const MIN_MEANINGFUL_PDF_PAGE_ALPHANUMERICS = 24;
export const DOCUMENT_EXTRACTION_TURN_TIMEOUT_MS = 12_000;
export const PDF_MODULE_INITIALIZATION_TIMEOUT_MS = 30_000;
export const MAX_DOCUMENT_EXTRACTION_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_EXTRACTION_COUNT = 8;
const require = createRequire(import.meta.url);
const sharedExtractionScheduler = new DocumentExtractionScheduler();

type PdfTextModule = Pick<
  typeof import("pdfjs-dist/legacy/build/pdf.mjs"),
  "getDocument"
>;
type PdfModuleLoader = () => Promise<PdfTextModule>;

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
  readonly pdfModuleLoader?: PdfModuleLoader;
  readonly generatedAttachmentStore?: PrivateGeneratedAttachmentStore;
  readonly scheduler?: DocumentExtractionScheduler;
  readonly signal?: AbortSignal;
}

export interface PreparedDocumentAttachments {
  readonly contexts: DocumentAttachmentContext[];
  readonly generatedImagePaths: string[];
  readonly imagePaths: string[];
}

interface PdfRasterBudget {
  remainingBytes: number;
  remainingCount: number;
}

interface GeneratedPdfPage {
  pageNumber: number;
  path: string;
}

interface PdfAnalysis {
  attachment: ChatAttachment;
  bytes: Uint8Array;
  generatedPages: GeneratedPdfPage[];
  rasterPageNumbers: number[];
  selectableText: string;
  textTruncated: boolean;
  totalPages: number;
}

class ScannedPdfRasterizationError extends Error {}

async function ensurePdfNodePrimitives(): Promise<void> {
  if (
    typeof Reflect.get(globalThis, "DOMMatrix") === "function"
    && typeof Reflect.get(globalThis, "Path2D") === "function"
    && typeof Reflect.get(globalThis, "ImageData") === "function"
  ) return;

  // PDF.js identifies Electron utility processes as non-Node and therefore
  // does not install its own canvas globals in the packaged runtime.
  const canvas = await import("@napi-rs/canvas");
  if (typeof Reflect.get(globalThis, "DOMMatrix") !== "function") {
    Reflect.set(globalThis, "DOMMatrix", canvas.DOMMatrix);
  }
  if (typeof Reflect.get(globalThis, "Path2D") !== "function") {
    Reflect.set(globalThis, "Path2D", canvas.Path2D);
  }
  if (typeof Reflect.get(globalThis, "ImageData") !== "function") {
    Reflect.set(globalThis, "ImageData", canvas.ImageData);
  }
}

async function loadPdfModule(): Promise<PdfTextModule> {
  await ensurePdfNodePrimitives();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
  return pdfjs;
}

export function createCachedPdfModuleLoader<T>(
  initialize: () => Promise<T>,
): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (cached) return cached;
    const started = Promise.resolve().then(initialize);
    const tracked = started.catch((error: unknown) => {
      if (cached === tracked) cached = null;
      throw error;
    });
    cached = tracked;
    return tracked;
  };
}

const sharedPdfModuleLoader = createCachedPdfModuleLoader(loadPdfModule);

export function awaitPdfModuleInitialization<T>(input: {
  readonly deadlineAt: number;
  readonly load: () => Promise<T>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}): Promise<T> {
  if (input.signal?.aborted) {
    return Promise.reject(new DocumentExtractionCancelledError());
  }
  const now = input.now ?? Date.now;
  const remainingMs = input.deadlineAt - now();
  if (remainingMs <= 0) {
    return Promise.reject(new DocumentExtractionInitializationError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      operation();
    };
    const cancel = () => {
      finish(() => reject(new DocumentExtractionCancelledError()));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new DocumentExtractionInitializationError()));
    }, Math.max(1, Math.trunc(remainingMs)));
    timer.unref();
    input.signal?.addEventListener("abort", cancel, { once: true });
    // Dynamic import cannot be cancelled safely. The shared initializer keeps
    // running after an individual waiter times out or is cancelled, allowing a
    // successful cold load to serve the next turn without duplicate native
    // initialization. Rejected loads are evicted by the cached loader.
    void Promise.resolve().then(input.load).then(
      (module) => finish(() => resolve(module)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
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

function hasMeaningfulPdfText(content: string): boolean {
  // Scanner overlays commonly add only a page number or short footer. Treat
  // that sparse incidental layer as visual content, not as a readable page.
  return (content.match(/[\p{L}\p{N}]/gu) ?? []).length
    >= MIN_MEANINGFUL_PDF_PAGE_ALPHANUMERICS;
}

function scannedPdfNote(
  analysis: PdfAnalysis,
  imageOrdinalByPath: ReadonlyMap<string, number>,
): string {
  const mappings = analysis.generatedPages.map(({ pageNumber, path }) => {
    const ordinal = imageOrdinalByPath.get(path);
    if (ordinal === undefined) {
      throw new Error("A scanned PDF page lost its provider image position.");
    }
    return `page ${pageNumber} as provider image ${ordinal}`;
  });
  const omittedScanned = analysis.rasterPageNumbers.length
    - analysis.generatedPages.length;
  const uninspected = Math.max(0, analysis.totalPages - MAX_PDF_PAGES);
  return [
    analysis.selectableText
      ? "Some PDF pages did not contain enough reliable selectable text."
      : "This PDF did not contain enough reliable selectable text.",
    `Inertia rasterized ${mappings.join(", ")} from ${analysis.attachment.name}.`,
    omittedScanned > 0
      ? `${omittedScanned} scanned page${omittedScanned === 1 ? " was" : "s were"} omitted by the bounded image-input limits.`
      : "Inspect those provider images directly.",
    uninspected > 0
      ? `${uninspected} page${uninspected === 1 ? " was" : "s were"} beyond the bounded PDF inspection limit.`
      : "",
  ].filter(Boolean).join("\n");
}

function checkExtractionPending(
  signal: AbortSignal,
  deadlineAt: number,
  now: () => number,
): void {
  if (signal.aborted) throw new DocumentExtractionCancelledError();
  if (now() >= deadlineAt) throw new DocumentExtractionDeadlineError();
}

function pdfDocumentOptions(bytes: Uint8Array): Parameters<PdfTextModule["getDocument"]>[0] {
  return {
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: MAX_PDF_SOURCE_IMAGE_PIXELS,
    canvasMaxAreaInBytes: MAX_PDF_SOURCE_RGBA_BYTES,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: 0,
  };
}

async function rasterizePdfPages(
  pdfModule: PdfTextModule,
  analysis: PdfAnalysis,
  pageNumbers: readonly number[],
  budget: PdfRasterBudget,
  generatedAttachments: PrivateGeneratedAttachmentStore,
  signal: AbortSignal,
  deadlineAt: number,
  now: () => number,
): Promise<GeneratedPdfPage[]> {
  checkExtractionPending(signal, deadlineAt, now);
  const { createCanvas } = await import("@napi-rs/canvas");
  checkExtractionPending(signal, deadlineAt, now);
  const loadingTask = pdfModule.getDocument(pdfDocumentOptions(analysis.bytes));
  const cancel = (): void => { void loadingTask.destroy(); };
  signal.addEventListener("abort", cancel, { once: true });
  const generated: GeneratedPdfPage[] = [];
  try {
    const document = await loadingTask.promise;
    checkExtractionPending(signal, deadlineAt, now);
    for (const pageNumber of pageNumbers) {
      if (budget.remainingCount < 1) break;
      checkExtractionPending(signal, deadlineAt, now);
      const page = await document.getPage(pageNumber);
      try {
        const baseline = page.getViewport({ scale: 1 });
        if (
          !Number.isFinite(baseline.width)
          || !Number.isFinite(baseline.height)
          || baseline.width <= 0
          || baseline.height <= 0
        ) throw new ScannedPdfRasterizationError(
          `${analysis.attachment.name} has an invalid page size.`,
        );
        const scale = Math.min(
          2,
          MAX_RASTER_DIMENSION / baseline.width,
          MAX_RASTER_DIMENSION / baseline.height,
          Math.sqrt(MAX_RASTER_PIXELS / (baseline.width * baseline.height)) * 0.99,
        );
        if (!Number.isFinite(scale) || scale <= 0) {
          throw new ScannedPdfRasterizationError(
            `${analysis.attachment.name} has an unsafe page scale.`,
          );
        }
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        if (
          width > MAX_RASTER_DIMENSION
          || height > MAX_RASTER_DIMENSION
          || width * height > MAX_RASTER_PIXELS
          || width * height * 4 > MAX_RASTER_RGBA_BYTES
        ) throw new ScannedPdfRasterizationError(
          `${analysis.attachment.name} has an unsafe page size.`,
        );
        const canvas = createCanvas(width, height);
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        const render = page.render({
          canvas: canvas as never,
          canvasContext: context as never,
          viewport,
          background: "#ffffff",
        });
        const cancelRender = (): void => render.cancel();
        signal.addEventListener("abort", cancelRender, { once: true });
        try {
          await render.promise;
        } catch (error) {
          if (signal.aborted) throw new DocumentExtractionCancelledError();
          throw error;
        } finally {
          signal.removeEventListener("abort", cancelRender);
        }
        checkExtractionPending(signal, deadlineAt, now);
        const jpeg = await canvas.encode("jpeg", 82);
        checkExtractionPending(signal, deadlineAt, now);
        if (jpeg.byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
          throw new ScannedPdfRasterizationError(
            `${analysis.attachment.name} produced a page image above the 10 MB limit.`,
          );
        }
        if (budget.remainingCount < 1 || jpeg.byteLength > budget.remainingBytes) {
          continue;
        }
        const path = await generatedAttachments.writeJpeg(jpeg);
        try {
          checkExtractionPending(signal, deadlineAt, now);
        } catch (error) {
          await generatedAttachments.release([path]).catch(() => undefined);
          throw error;
        }
        budget.remainingCount -= 1;
        budget.remainingBytes -= jpeg.byteLength;
        generated.push({ pageNumber, path });
      } finally {
        page.cleanup();
      }
    }
    return generated;
  } catch (error) {
    await generatedAttachments.release(
      generated.map(({ path }) => path),
    ).catch(() => undefined);
    if (signal.aborted) throw new DocumentExtractionCancelledError();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    await loadingTask.destroy().catch(() => undefined);
  }
}

async function extractPdfAnalysis(
  pdfModule: PdfTextModule,
  attachment: ChatAttachment,
  bytes: Uint8Array,
  maximumJsonBytes: number,
  signal: AbortSignal,
  deadlineAt: number,
  now: () => number,
): Promise<PdfAnalysis> {
  const loadingTask = pdfModule.getDocument(pdfDocumentOptions(bytes));
  const cancel = () => {
    void loadingTask.destroy();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    checkExtractionPending(signal, deadlineAt, now);
    const document = await loadingTask.promise;
    const pageLimit = Math.min(document.numPages, MAX_PDF_PAGES);
    const accumulator = boundedTextAccumulator(maximumJsonBytes);
    const rasterPageNumbers: number[] = [];
    let hasSelectableText = false;
    let textTruncated = false;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      checkExtractionPending(signal, deadlineAt, now);
      const page = await document.getPage(pageNumber);
      const pageAccumulator = boundedTextAccumulator(MAX_DOCUMENT_CONTEXT_BYTES);
      try {
        const reader = page.streamTextContent().getReader();
        let streamDone = false;
        try {
          while (!streamDone) {
            checkExtractionPending(signal, deadlineAt, now);
            const chunk = await reader.read();
            streamDone = chunk.done;
            if (streamDone) break;
            const items = (chunk.value as { items?: readonly unknown[] }).items;
            if (!Array.isArray(items)) continue;
            for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
              if (
                itemIndex % 256 === 0
                && now() >= deadlineAt
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
              if (!pageAccumulator.append(textItem.str)) textTruncated = true;
              if (textItem.hasEOL && !pageAccumulator.append("\n")) {
                textTruncated = true;
              }
            }
          }
        } finally {
          if (!streamDone) void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      } finally {
        page.cleanup();
      }
      const pageText = pageAccumulator.content();
      if (!hasMeaningfulPdfText(pageText)) {
        rasterPageNumbers.push(pageNumber);
        continue;
      }
      const prefixed = `${hasSelectableText ? "\n\n" : ""}[Page ${pageNumber}]\n${pageText}`;
      if (!accumulator.append(prefixed)) textTruncated = true;
      hasSelectableText = true;
    }
    return {
      attachment,
      bytes,
      generatedPages: [],
      rasterPageNumbers,
      selectableText: accumulator.content(),
      textTruncated,
      totalPages: document.numPages,
    };
  } catch (error) {
    if (signal.aborted) throw new DocumentExtractionCancelledError();
    if (
      error instanceof Error
      && (
        error instanceof DocumentExtractionCancelledError
        || error instanceof DocumentExtractionDeadlineError
        || error instanceof ScannedPdfRasterizationError
      )
    ) throw error;
    throw new Error(`${attachment.name} could not be read as a PDF.`);
  } finally {
    signal.removeEventListener("abort", cancel);
    await loadingTask.destroy().catch(() => undefined);
  }
}

function contextForPdf(
  analysis: PdfAnalysis,
  maximumJsonBytes: number,
  imageOrdinalByPath: ReadonlyMap<string, number>,
): DocumentAttachmentContext {
  const rasterNote = analysis.rasterPageNumbers.length > 0
    ? scannedPdfNote(analysis, imageOrdinalByPath)
    : "";
  const combined = [
    rasterNote,
    analysis.selectableText
      ? `${rasterNote ? "Selectable text from the other pages:\n" : ""}${analysis.selectableText}`
      : "",
  ].filter(Boolean).join("\n\n");
  const bounded = boundedUtf8(combined, maximumJsonBytes);
  return {
    attachmentId: analysis.attachment.id,
    label: `PDF · ${analysis.attachment.name}`,
    content: bounded.value,
    truncated: analysis.textTruncated
      || bounded.truncated
      || analysis.totalPages > MAX_PDF_PAGES
      || analysis.generatedPages.length < analysis.rasterPageNumbers.length,
  };
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

export async function prepareDocumentAttachments(
  payloads: readonly ResolvedAttachmentPayload[],
  options: DocumentAttachmentContextOptions = {},
): Promise<PreparedDocumentAttachments> {
  const existingImages = payloads.filter(({ attachment }) =>
    chatAttachmentKind(attachment.mimeType) === "image");
  const existingImageBytes = existingImages.reduce(
    (total, { bytes }) => total + bytes.byteLength,
    0,
  );
  if (
    existingImages.length > MAX_CHAT_ATTACHMENTS
    || existingImageBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES
  ) throw new Error("Image attachments exceed the shared turn limits.");
  const rasterBudget: PdfRasterBudget = {
    remainingBytes: MAX_CHAT_ATTACHMENT_TOTAL_BYTES - existingImageBytes,
    remainingCount: MAX_CHAT_ATTACHMENTS - existingImages.length,
  };
  const documents = payloads.flatMap((payload) =>
    payload.attachment.mimeType.startsWith("image/")
      ? []
      : [payload]);
  if (documents.length === 0) {
    return {
      contexts: [],
      generatedImagePaths: [],
      imagePaths: existingImages.map(({ attachment }) => attachment.path),
    };
  }
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
  const preparationDeadlineAt = options.deadlineAt
    ?? Number.POSITIVE_INFINITY;
  const hasPdf = documents.some(
    ({ attachment }) => attachment.mimeType === "application/pdf",
  );
  const pdfModule = hasPdf
    ? await awaitPdfModuleInitialization({
        deadlineAt: Math.min(
          preparationDeadlineAt,
          now() + PDF_MODULE_INITIALIZATION_TIMEOUT_MS,
        ),
        load: options.pdfModuleLoader ?? sharedPdfModuleLoader,
        now,
        signal: options.signal,
      })
    : null;
  const deadlineAt = Math.min(
    preparationDeadlineAt,
    now() + DOCUMENT_EXTRACTION_TURN_TIMEOUT_MS,
  );
  if (deadlineAt <= now()) throw new DocumentExtractionDeadlineError();
  const groupId = options.groupId ?? randomUUID();
  const scheduler = options.scheduler ?? sharedExtractionScheduler;
  const maximumJsonBytes = Math.floor(
    MAX_DOCUMENT_CONTEXT_TOTAL_BYTES / documents.length,
  );
  const batchAbort = new AbortController();
  const cancelBatch = (): void => batchAbort.abort();
  options.signal?.addEventListener("abort", cancelBatch, { once: true });
  const generatedImagePaths: string[] = [];
  try {
    const extractions = documents.map(async ({ attachment, bytes }) => {
      try {
        if (batchAbort.signal.aborted) {
          throw new DocumentExtractionCancelledError();
        }
        if (attachment.mimeType === "application/pdf") {
          return {
            kind: "pdf" as const,
            analysis: await scheduler.schedule({
              groupId,
              weight: bytes.byteLength,
              deadlineAt,
              signal: batchAbort.signal,
              onOperationFailure: (error) => {
                if (!(error instanceof DocumentExtractionCancelledError)) {
                  batchAbort.abort();
                }
              },
              operation: (signal) => extractPdfAnalysis(
                pdfModule!,
                attachment,
                bytes,
                maximumJsonBytes,
                signal,
                deadlineAt,
                now,
              ),
            }),
          };
        }
        const extracted = extractTextDocument(
          attachment,
          bytes,
          maximumJsonBytes,
        );
        return {
          kind: "text" as const,
          context: {
            attachmentId: attachment.id,
            label: `Document · ${attachment.name}`,
            content: extracted.content,
            truncated: extracted.truncated,
          } satisfies DocumentAttachmentContext,
        };
      } catch (error) {
        if (!(error instanceof DocumentExtractionCancelledError)) {
          batchAbort.abort();
        }
        throw error;
      }
    });
    const settled = await Promise.allSettled(extractions);
    const failed = settled.find((result): result is PromiseRejectedResult =>
      result.status === "rejected"
      && !(result.reason instanceof DocumentExtractionCancelledError));
    if (failed) {
      if (failed.reason instanceof DocumentExtractionDeadlineError) {
        throw new Error("PDF text extraction timed out.");
      }
      throw failed.reason;
    }
    const cancelled = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (cancelled) throw cancelled.reason;
    const analyzed = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const scannedPdfs = analyzed.flatMap((result) =>
      result.kind === "pdf" && result.analysis.rasterPageNumbers.length > 0
        ? [result.analysis]
        : []);
    if (scannedPdfs.length > 0 && !options.generatedAttachmentStore) {
      throw new ScannedPdfRasterizationError(
        "Scanned PDF pages require private generated-attachment storage.",
      );
    }
    if (scannedPdfs.length > rasterBudget.remainingCount) {
      throw new ScannedPdfRasterizationError(
        `Every scanned PDF needs at least one page image, but this turn only has ${rasterBudget.remainingCount} image slot${rasterBudget.remainingCount === 1 ? "" : "s"} left.`,
      );
    }

    // Allocate one page per PDF per round before doing any rendering. This is
    // deterministic and prevents the first PDF from consuming every slot.
    const allocatedPages = new Map<PdfAnalysis, number[]>();
    let remainingSlots = rasterBudget.remainingCount;
    for (let round = 0; remainingSlots > 0; round += 1) {
      let foundCandidate = false;
      for (const analysis of scannedPdfs) {
        const pageNumber = analysis.rasterPageNumbers[round];
        if (pageNumber === undefined || remainingSlots < 1) continue;
        foundCandidate = true;
        const pages = allocatedPages.get(analysis);
        if (pages) pages.push(pageNumber);
        else allocatedPages.set(analysis, [pageNumber]);
        remainingSlots -= 1;
      }
      if (!foundCandidate) break;
    }

    // Each PDF is parsed once for all of its allocated pages. Rendering stays
    // sequential, so the scheduler accounts for exactly one bounded canvas.
    for (const analysis of scannedPdfs) {
      const pages = allocatedPages.get(analysis) ?? [];
      if (pages.length === 0) continue;
      const generated = await scheduler.schedule({
        groupId,
        weight: analysis.bytes.byteLength
          + MAX_PDF_SOURCE_RGBA_BYTES
          + MAX_RASTER_RGBA_BYTES,
        deadlineAt,
        signal: batchAbort.signal,
        operation: (signal) => rasterizePdfPages(
          pdfModule!,
          analysis,
          pages,
          rasterBudget,
          options.generatedAttachmentStore!,
          signal,
          deadlineAt,
          now,
        ),
      });
      analysis.generatedPages.push(...generated);
      generatedImagePaths.push(...generated.map(({ path }) => path));
    }
    const unreadablePdf = scannedPdfs.find(
      ({ generatedPages }) => generatedPages.length === 0,
    );
    if (unreadablePdf) {
      throw new ScannedPdfRasterizationError(
        `${unreadablePdf.attachment.name} needs a page image, but the turn's 20 MB image budget is exhausted.`,
      );
    }

    const analysisById = new Map(scannedPdfs.map((analysis) => [
      analysis.attachment.id,
      analysis,
    ]));
    const imagePaths = payloads.flatMap(({ attachment }) => {
      if (chatAttachmentKind(attachment.mimeType) === "image") {
        return [attachment.path];
      }
      return analysisById.get(attachment.id)?.generatedPages.map(
        ({ path }) => path,
      ) ?? [];
    });
    const imageOrdinalByPath = new Map(
      imagePaths.map((path, index) => [path, index + 1]),
    );
    const contexts = analyzed.map((result) => result.kind === "text"
      ? result.context
      : contextForPdf(
          result.analysis,
          maximumJsonBytes,
          imageOrdinalByPath,
        ));
    return {
      contexts,
      generatedImagePaths: imagePaths.filter((path) =>
        generatedImagePaths.includes(path)),
      imagePaths,
    };
  } catch (error) {
    batchAbort.abort();
    await options.generatedAttachmentStore?.release(generatedImagePaths)
      .catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancelBatch);
  }
}

export async function documentAttachmentContexts(
  payloads: readonly ResolvedAttachmentPayload[],
  options: DocumentAttachmentContextOptions = {},
): Promise<DocumentAttachmentContext[]> {
  let prepared: PreparedDocumentAttachments;
  try {
    prepared = await prepareDocumentAttachments(payloads, options);
  } catch (error) {
    if (
      !options.generatedAttachmentStore
      && error instanceof ScannedPdfRasterizationError
    ) {
      throw new Error("Scanned PDF pages require the image-aware turn pipeline.");
    }
    throw error;
  }
  try {
    if (prepared.generatedImagePaths.length > 0) {
      throw new Error("Scanned PDF pages require the image-aware turn pipeline.");
    }
    return prepared.contexts;
  } finally {
    await options.generatedAttachmentStore?.release(prepared.generatedImagePaths);
  }
}
