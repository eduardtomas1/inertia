import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import * as XLSX from "xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatAttachment } from "../../src/shared/contracts";
import {
  awaitPdfModuleInitialization,
  createCachedPdfModuleLoader,
  documentAttachmentContexts,
  PDF_MODULE_INITIALIZATION_TIMEOUT_MS,
  pdfTextItemsToText,
  prepareDocumentAttachments,
} from "../../src/server/runtime/attachments/document-attachment-context";
import { PrivateGeneratedAttachmentStore } from "../../src/server/runtime/attachments/private-generated-attachments";
import { assembleTurnRequest } from "../../src/server/runtime/turns/request-context";
import {
  DocumentExtractionCancelledError,
  DocumentExtractionInitializationError,
} from "../../src/server/runtime/attachments/document-extraction-scheduler";

function pdfWithText(text: string): Uint8Array {
  const stream = `BT /F1 22 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
      + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

function pdfWithBinaryObjects(objects: readonly Buffer[]): Uint8Array {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets: number[] = [];
  let length = chunks[0]!.byteLength;
  objects.forEach((object, index) => {
    const prefix = Buffer.from(`${index + 1} 0 obj\n`, "ascii");
    const suffix = Buffer.from("\nendobj\n", "ascii");
    offsets.push(length);
    chunks.push(prefix, object, suffix);
    length += prefix.byteLength + object.byteLength + suffix.byteLength;
  });
  const xrefOffset = length;
  const xref = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
      + offsets.map((offset) =>
        `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
      + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
      + `startxref\n${xrefOffset}\n%%EOF\n`,
    "ascii",
  );
  return Buffer.concat([...chunks, xref]);
}

async function scannedPdfWithImage(): Promise<Uint8Array> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(160, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 160, 100);
  context.fillStyle = "#111111";
  context.font = "18px sans-serif";
  context.fillText("SCANNED 123", 16, 56);
  const jpeg = await canvas.encode("jpeg", 85);
  const draw = Buffer.from("q 160 0 0 100 0 0 cm /Im1 Do Q", "ascii");
  return pdfWithBinaryObjects([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 100] "
        + "/Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
      "ascii",
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${draw.byteLength} >>\nstream\n`, "ascii"),
      draw,
      Buffer.from("\nendstream", "ascii"),
    ]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 160 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`,
        "ascii",
      ),
      jpeg,
      Buffer.from("\nendstream", "ascii"),
    ]),
  ]);
}

function pdfWithTextPages(texts: readonly string[]): Uint8Array {
  const fontReference = 3 + texts.length * 2;
  const pageReferences = texts.map((_, index) => 3 + index * 2);
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from(
      `<< /Type /Pages /Kids [${pageReferences.map((id) => `${id} 0 R`).join(" ")}] /Count ${texts.length} >>`,
      "ascii",
    ),
  ];
  texts.forEach((text, index) => {
    const contentReference = 4 + index * 2;
    const stream = `BT /F1 22 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontReference} 0 R >> >> /Contents ${contentReference} 0 R >>`,
        "ascii",
      ),
      Buffer.from(
        `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
        "ascii",
      ),
    );
  });
  objects.push(Buffer.from(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "ascii",
  ));
  return pdfWithBinaryObjects(objects);
}

function attachment(
  update: Partial<ChatAttachment>,
): ChatAttachment {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "notes.pdf",
    path: "/private/runtime/notes.pdf",
    mimeType: "application/pdf",
    size: 1,
    ...update,
  };
}

function spreadsheetBytes(bookType: "xlsx" | "xls"): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Region", "Revenue"],
      ["North", 1_200],
      ["South", 980],
    ]),
    "Quarter 1",
  );
  return XLSX.write(workbook, { type: "buffer", bookType }) as Uint8Array;
}

const hostedWindowsCi =
  process.platform === "win32" && process.env.CI === "true";
const temporaryDirectories: string[] = [];

async function generatedStore(
  directory: string,
): Promise<PrivateGeneratedAttachmentStore> {
  return await PrivateGeneratedAttachmentStore.create(
    join(directory, "runtime-data"),
  );
}

describe("document attachment execution context", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it("preserves PDF.js text-item spacing and punctuation", () => {
    expect(pdfTextItemsToText([
      { str: "exam", hasEOL: false },
      { str: "ple", hasEOL: false },
      { str: " ", hasEOL: false },
      { str: "word", hasEOL: false },
      { str: ",", hasEOL: true },
      { str: "next line", hasEOL: false },
    ])).toBe("example word,\nnext line");
  });

  it("stops converting PDF text items at the per-document boundary", () => {
    const text = pdfTextItemsToText(Array.from(
      { length: 100_000 },
      (_, index) => ({ str: `token-${index} `, hasEOL: false }),
    ));

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(text).toContain("token-0");
    expect(text).not.toContain("token-99999");
  });

  // Hosted Windows can spend the complete product cold-start deadline loading
  // the native PDF stack while the full unit suite is contending for two
  // workers. The later packaged-app smoke is the authoritative Windows proof:
  // it loads the real stack after runtime readiness and extracts a real PDF.
  // Keep these faster integration checks on local, Linux, and macOS runs.
  it.skipIf(hostedWindowsCi)(
    "extracts bounded PDF text without exposing the private source path",
    async () => {
      const pdf = attachment({});
      const contexts = await documentAttachmentContexts([{
        attachment: pdf,
        bytes: pdfWithText("Inertia PDF context with enough readable words"),
      }]);

      expect(contexts).toEqual([{
        attachmentId: pdf.id,
        label: "PDF · notes.pdf",
        content: "[Page 1]\nInertia PDF context with enough readable words",
        truncated: false,
      }]);
      expect(JSON.stringify(contexts)).not.toContain(pdf.path);
    },
    PDF_MODULE_INITIALIZATION_TIMEOUT_MS + 15_000,
  );

  it("bounds a cold PDF module wait without poisoning the shared cache", async () => {
    vi.useFakeTimers();
    let finishInitialization: ((value: string) => void) | undefined;
    let initializationCount = 0;
    const load = createCachedPdfModuleLoader(async () => {
      initializationCount += 1;
      return await new Promise<string>((resolve) => {
        finishInitialization = resolve;
      });
    });
    const cold = awaitPdfModuleInitialization({
      deadlineAt: Date.now() + PDF_MODULE_INITIALIZATION_TIMEOUT_MS,
      load,
    });
    const rejected = expect(cold).rejects.toBeInstanceOf(
      DocumentExtractionInitializationError,
    );

    await vi.advanceTimersByTimeAsync(PDF_MODULE_INITIALIZATION_TIMEOUT_MS);
    await rejected;
    finishInitialization?.("ready");
    await vi.runAllTimersAsync();
    await expect(awaitPdfModuleInitialization({
      deadlineAt: Date.now() + 1_000,
      load,
    })).resolves.toBe("ready");
    expect(initializationCount).toBe(1);
  });

  it("cancels only the PDF module waiter and retries rejected initialization", async () => {
    const controller = new AbortController();
    let finishInitialization: ((value: string) => void) | undefined;
    let initializationCount = 0;
    const load = createCachedPdfModuleLoader(async () => {
      initializationCount += 1;
      if (initializationCount === 1) {
        return await new Promise<string>((resolve) => {
          finishInitialization = resolve;
        });
      }
      return "retried";
    });
    const cancelled = awaitPdfModuleInitialization({
      deadlineAt: Date.now() + 1_000,
      load,
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(
      DocumentExtractionCancelledError,
    );
    finishInitialization?.("cached");
    await expect(awaitPdfModuleInitialization({
      deadlineAt: Date.now() + 1_000,
      load,
    })).resolves.toBe("cached");
    expect(initializationCount).toBe(1);

    let rejectionCount = 0;
    const retrying = createCachedPdfModuleLoader(async () => {
      rejectionCount += 1;
      if (rejectionCount === 1) throw new Error("cold load failed");
      return "recovered";
    });
    await expect(retrying()).rejects.toThrow("cold load failed");
    await expect(retrying()).resolves.toBe("recovered");
    expect(rejectionCount).toBe(2);
  });

  it("adds verified UTF-8 documents and ignores images", async () => {
    const text = attachment({
      name: "brief.md",
      mimeType: "text/markdown",
    });
    const image = attachment({
      id: "22222222-2222-4222-8222-222222222222",
      name: "preview.png",
      mimeType: "image/png",
    });

    await expect(documentAttachmentContexts([
      { attachment: image, bytes: new Uint8Array([1, 2, 3]) },
      { attachment: text, bytes: Buffer.from("# Brief\nUse this context.") },
    ])).resolves.toEqual([{
      attachmentId: text.id,
      label: "Document · brief.md",
      content: "# Brief\nUse this context.",
      truncated: false,
    }]);
  });

  it.each([
    ["notes.txt", "text/plain", "Plain attachment context."],
    ["brief.md", "text/markdown", "# Markdown attachment context"],
    ["rows.csv", "text/csv", "name,value\nAlpha,42"],
    ["data.json", "application/json", '{"safe":true}'],
  ] as const)("carries bounded %s content into the shared provider prompt", async (
    name,
    mimeType,
    content,
  ) => {
    const document = attachment({ name, mimeType });
    const contexts = await documentAttachmentContexts([{
      attachment: document,
      bytes: Buffer.from(content, "utf8"),
    }]);
    const assembled = assembleTurnRequest({
      cwd: process.cwd(),
      visibleContent: "Inspect the attachment.",
      attachments: [document],
      documentContexts: contexts,
    });

    expect(contexts).toEqual([{
      attachmentId: document.id,
      label: `Document · ${name}`,
      content,
      truncated: false,
    }]);
    expect(assembled.executionPrompt).toContain(JSON.stringify(content));
    expect(assembled.persistence.manifest).toMatchObject({
      contextReferenceCount: 1,
      imageCount: 0,
    });
  });

  it.each([
    [
      "xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["xls", "application/vnd.ms-excel"],
  ] as const)("extracts bounded %s worksheet context for every provider", async (
    extension,
    mimeType,
  ) => {
    const bytes = spreadsheetBytes(extension);
    const workbook = attachment({
      name: `forecast.${extension}`,
      mimeType,
      size: bytes.byteLength,
    });

    await expect(documentAttachmentContexts([
      { attachment: workbook, bytes },
    ])).resolves.toEqual([{
      attachmentId: workbook.id,
      label: `Spreadsheet · forecast.${extension}`,
      content: expect.stringMatching(
        /\[Worksheet: Quarter 1\][\s\S]*Row\tA\tB[\s\S]*2\tNorth\t1200/u,
      ),
      truncated: false,
    }]);
  });

  it("shares one bounded payload budget across multiple documents", async () => {
    const documents = Array.from({ length: 4 }, (_, index) => ({
      attachment: attachment({
        id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
        name: `brief-${index + 1}.txt`,
        mimeType: "text/plain" as const,
      }),
      bytes: Buffer.from(`Document ${index + 1}\n${"a".repeat(64 * 1024)}`),
    }));

    const contexts = await documentAttachmentContexts(documents);

    expect(contexts).toHaveLength(4);
    expect(contexts.every(({ truncated }) => truncated)).toBe(true);
    expect(contexts.reduce(
      (total, { content }) =>
        total + Buffer.byteLength(JSON.stringify(content).slice(1, -1), "utf8"),
      0,
    )).toBeLessThanOrEqual(96 * 1024);
  });

  it.skipIf(hostedWindowsCi)(
    "rasterizes a real scanned PDF into a private UUID JPEG without exposing paths",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inertia-scanned-pdf-"));
      temporaryDirectories.push(directory);
      const bytes = await scannedPdfWithImage();
      const pdf = attachment({
        name: `${"検査済み-📄-".repeat(20)}scan.pdf`,
        path: join(directory, "11111111-1111-4111-8111-111111111111.pdf"),
        size: bytes.byteLength,
      });
      await writeFile(pdf.path, bytes);
      const originalImage = attachment({
        id: "22222222-2222-4222-8222-222222222222",
        name: "reference.png",
        path: join(directory, "22222222-2222-4222-8222-222222222222.png"),
        mimeType: "image/png",
        size: 8,
      });
      const originalImageBytes = Buffer.from("89504e470d0a1a0a", "hex");
      await writeFile(originalImage.path, originalImageBytes);
      const store = await generatedStore(directory);

      const prepared = await prepareDocumentAttachments([
        { attachment: originalImage, bytes: originalImageBytes },
        { attachment: pdf, bytes },
      ], { generatedAttachmentStore: store });

      expect(prepared.contexts).toEqual([expect.objectContaining({
        attachmentId: pdf.id,
        label: `PDF · ${pdf.name}`,
        content: expect.stringMatching(/rasterized page 1 as provider image 2/u),
        truncated: false,
      })]);
      expect(prepared.generatedImagePaths).toHaveLength(1);
      expect(prepared.imagePaths).toEqual([
        originalImage.path,
        ...prepared.generatedImagePaths,
      ]);
      const generated = prepared.generatedImagePaths[0]!;
      expect(basename(generated)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/iu,
      );
      expect(generated).not.toContain("検査済み");
      expect((await readFile(generated)).subarray(0, 2))
        .toEqual(Buffer.from([0xff, 0xd8]));
      if (process.platform !== "win32") {
        expect((await stat(generated)).mode & 0o777).toBe(0o600);
      }
      expect(JSON.stringify(prepared.contexts)).not.toContain(directory);
      const assembled = assembleTurnRequest({
        cwd: directory,
        visibleContent: "Inspect the scanned page.",
        attachments: [originalImage, pdf],
        imagePaths: prepared.imagePaths,
        documentContexts: prepared.contexts,
      });
      expect(assembled.persistence.manifest).toMatchObject({
        imageCount: 2,
        contextReferenceCount: 1,
      });
      expect(JSON.stringify(assembled.persistence)).not.toContain(directory);
      expect(assembled.executionPrompt).not.toContain(directory);

      await store.release(prepared.generatedImagePaths);
      await expect(readFile(generated)).rejects.toThrow();
    },
    PDF_MODULE_INITIALIZATION_TIMEOUT_MS + 15_000,
  );

  it.skipIf(hostedWindowsCi)(
    "uses the image-aware pipeline for a fake blank scan and rejects the text-only wrapper",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inertia-blank-pdf-"));
      temporaryDirectories.push(directory);
      const bytes = pdfWithText(" ");
      const pdf = attachment({
        path: join(directory, "11111111-1111-4111-8111-111111111111.pdf"),
        size: bytes.byteLength,
      });
      await writeFile(pdf.path, bytes);
      const store = await generatedStore(directory);
      const prepared = await prepareDocumentAttachments(
        [{ attachment: pdf, bytes }],
        { generatedAttachmentStore: store },
      );
      expect(prepared.generatedImagePaths).toHaveLength(1);
      expect(prepared.contexts[0]?.content).toMatch(/provider image 1/u);
      await store.release(prepared.generatedImagePaths);

      await expect(documentAttachmentContexts([{ attachment: pdf, bytes }]))
        .rejects.toThrow(/image-aware turn pipeline/u);
    },
    PDF_MODULE_INITIALIZATION_TIMEOUT_MS + 15_000,
  );

  it.skipIf(hostedWindowsCi)(
    "falls back for incidental tiny text across multiple pages",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inertia-tiny-text-pdf-"));
      temporaryDirectories.push(directory);
      const bytes = pdfWithTextPages(["x", "y"]);
      const pdf = attachment({
        path: join(directory, "11111111-1111-4111-8111-111111111111.pdf"),
        size: bytes.byteLength,
      });
      await writeFile(pdf.path, bytes);
      const store = await generatedStore(directory);

      const prepared = await prepareDocumentAttachments(
        [{ attachment: pdf, bytes }],
        { generatedAttachmentStore: store },
      );

      expect(prepared.generatedImagePaths).toHaveLength(2);
      expect(prepared.contexts[0]).toMatchObject({
        content: expect.stringMatching(/page 1 as provider image 1, page 2 as provider image 2/u),
        truncated: false,
      });
      await store.release(prepared.generatedImagePaths);
    },
    PDF_MODULE_INITIALIZATION_TIMEOUT_MS + 15_000,
  );

  it.skipIf(hostedWindowsCi)(
    "rasterizes only a hybrid PDF's sparse footer page",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inertia-hybrid-pdf-"));
      temporaryDirectories.push(directory);
      const bytes = pdfWithTextPages([
        "This first page contains meaningful selectable document text.",
        "Page 2 of 2",
      ]);
      const pdf = attachment({
        path: join(directory, "11111111-1111-4111-8111-111111111111.pdf"),
        size: bytes.byteLength,
      });
      const store = await generatedStore(directory);

      const prepared = await prepareDocumentAttachments(
        [{ attachment: pdf, bytes }],
        { generatedAttachmentStore: store },
      );

      expect(prepared.generatedImagePaths).toHaveLength(1);
      expect(prepared.contexts[0]).toMatchObject({
        content: expect.stringMatching(
          /page 2 as provider image 1[\s\S]*meaningful selectable documen/u,
        ),
        truncated: false,
      });
      expect(prepared.contexts[0]?.content).not.toMatch(
        /page 1 as provider image/u,
      );
      await store.release(prepared.generatedImagePaths);
    },
    PDF_MODULE_INITIALIZATION_TIMEOUT_MS + 15_000,
  );

  it.skipIf(hostedWindowsCi)(
    "allocates multiple scanned PDFs fairly and preserves mixed attachment order",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inertia-fair-pdfs-"));
      temporaryDirectories.push(directory);
      const store = await generatedStore(directory);
      const firstBytes = pdfWithTextPages(Array.from(
        { length: 5 },
        (_, index) => `Page ${index + 1} of 5`,
      ));
      const secondBytes = pdfWithTextPages(Array.from(
        { length: 5 },
        (_, index) => `Sheet ${index + 1} of 5`,
      ));
      const firstPdf = attachment({
        id: "11111111-1111-4111-8111-111111111111",
        name: "first.pdf",
        path: join(directory, "11111111-1111-4111-8111-111111111111.pdf"),
        size: firstBytes.byteLength,
      });
      const firstImage = attachment({
        id: "22222222-2222-4222-8222-222222222222",
        name: "between.png",
        path: join(directory, "22222222-2222-4222-8222-222222222222.png"),
        mimeType: "image/png",
        size: 8,
      });
      const secondPdf = attachment({
        id: "33333333-3333-4333-8333-333333333333",
        name: "second.pdf",
        path: join(directory, "33333333-3333-4333-8333-333333333333.pdf"),
        size: secondBytes.byteLength,
      });
      const lastImage = attachment({
        id: "44444444-4444-4444-8444-444444444444",
        name: "last.png",
        path: join(directory, "44444444-4444-4444-8444-444444444444.png"),
        mimeType: "image/png",
        size: 8,
      });

      const prepared = await prepareDocumentAttachments([
        { attachment: firstPdf, bytes: firstBytes },
        { attachment: firstImage, bytes: Buffer.alloc(8) },
        { attachment: secondPdf, bytes: secondBytes },
        { attachment: lastImage, bytes: Buffer.alloc(8) },
      ], { generatedAttachmentStore: store });

      expect(prepared.generatedImagePaths).toHaveLength(6);
      expect(prepared.imagePaths).toEqual([
        ...prepared.generatedImagePaths.slice(0, 3),
        firstImage.path,
        ...prepared.generatedImagePaths.slice(3),
        lastImage.path,
      ]);
      expect(prepared.contexts[0]?.content).toMatch(
        /provider image 1, page 2 as provider image 2, page 3 as provider image 3/u,
      );
      expect(prepared.contexts[1]?.content).toMatch(
        /provider image 5, page 2 as provider image 6, page 3 as provider image 7/u,
      );
      await store.release(prepared.generatedImagePaths);
    },
    PDF_MODULE_INITIALIZATION_TIMEOUT_MS + 15_000,
  );

  it("cleans an earlier generated page when a later raster is aborted", async () => {
    // This test owns a mocked PDF pipeline and is not exercising the native
    // canvas cold start. Warm that dependency before the product deadline is
    // created so a contended hosted Windows worker still reaches the exact
    // second-render cancellation boundary the test is meant to prove.
    await import("@napi-rs/canvas");
    const directory = await mkdtemp(join(tmpdir(), "inertia-raster-abort-"));
    temporaryDirectories.push(directory);
    const store = await generatedStore(directory);
    const controller = new AbortController();
    let rasterLoad = false;
    let notifySecondRender!: () => void;
    const secondRenderStarted = new Promise<void>((resolve) => {
      notifySecondRender = resolve;
    });
    let rejectSecondRender!: (error: Error) => void;
    const pdfModule = {
      getDocument() {
        const isRaster = rasterLoad;
        rasterLoad = true;
        return {
          promise: Promise.resolve({
            numPages: 2,
            getPage: async (pageNumber: number) => ({
              cleanup: () => undefined,
              getViewport: ({ scale }: { scale: number }) => ({
                width: 612 * scale,
                height: 792 * scale,
              }),
              streamTextContent: () => {
                let read = false;
                return new ReadableStream({
                  pull(streamController) {
                    if (read) streamController.close();
                    else {
                      read = true;
                      streamController.enqueue({
                        items: [{ str: `Page ${pageNumber} of 2`, hasEOL: false }],
                      });
                    }
                  },
                });
              },
              render: () => {
                if (!isRaster || pageNumber === 1) {
                  return { promise: Promise.resolve(), cancel: () => undefined };
                }
                notifySecondRender();
                return {
                  promise: new Promise<void>((_resolve, reject) => {
                    rejectSecondRender = reject;
                  }),
                  cancel: () => rejectSecondRender(new Error("render cancelled")),
                };
              },
            }),
          }),
          destroy: async () => undefined,
        };
      },
    };
    const pdf = attachment({});
    const preparation = prepareDocumentAttachments([{
      attachment: pdf,
      bytes: new Uint8Array([1]),
    }], {
      generatedAttachmentStore: store,
      pdfModuleLoader: async () => pdfModule as never,
      signal: controller.signal,
    });

    await secondRenderStarted;
    expect(store.usage().records).toBe(1);
    controller.abort();
    await expect(preparation).rejects.toBeInstanceOf(
      DocumentExtractionCancelledError,
    );
    await vi.waitFor(() => expect(store.usage()).toEqual({
      bytes: 0,
      records: 0,
    }));
  }, PDF_MODULE_INITIALIZATION_TIMEOUT_MS + 15_000);

  it.skipIf(hostedWindowsCi)(
    "cleans a final page when cancellation wins immediately after its private write",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inertia-post-write-abort-"));
      temporaryDirectories.push(directory);
      const backingStore = await generatedStore(directory);
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
      let notifyWritten!: () => void;
      const written = new Promise<void>((resolve) => { notifyWritten = resolve; });
      const delayedStore = {
        writeJpeg: async (bytes: Uint8Array) => {
          const path = await backingStore.writeJpeg(bytes);
          notifyWritten();
          await writeGate;
          return path;
        },
        release: (paths: readonly string[]) => backingStore.release(paths),
      } as unknown as PrivateGeneratedAttachmentStore;
      const controller = new AbortController();
      const pdf = attachment({});
      const preparation = prepareDocumentAttachments([{
        attachment: pdf,
        bytes: pdfWithText("Page 1 of 1"),
      }], {
        generatedAttachmentStore: delayedStore,
        signal: controller.signal,
      });
      const rejection = expect(preparation).rejects.toBeInstanceOf(
        DocumentExtractionCancelledError,
      );

      await written;
      expect(backingStore.usage().records).toBe(1);
      controller.abort();
      releaseWrite();
      await rejection;
      await vi.waitFor(() => expect(backingStore.usage()).toEqual({
        bytes: 0,
        records: 0,
      }));
    },
    PDF_MODULE_INITIALIZATION_TIMEOUT_MS + 15_000,
  );

  it("aborts running and queued sibling PDFs after the first substantive failure", async () => {
    let started = 0;
    let destroyedHanging = 0;
    const pdfModule = {
      getDocument({ data }: { data: Uint8Array }) {
        started += 1;
        if (data[0] === 2) {
          return {
            promise: Promise.reject(new Error("invalid fixture")),
            destroy: async () => undefined,
          };
        }
        let rejectLoad!: (error: Error) => void;
        return {
          promise: new Promise((_resolve, reject) => { rejectLoad = reject; }),
          destroy: async () => {
            destroyedHanging += 1;
            rejectLoad(new Error("destroyed by sibling cancellation"));
          },
        };
      },
    };
    const documents = Array.from({ length: 8 }, (_, index) => ({
      attachment: attachment({
        id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
        name: `${index + 1}.pdf`,
      }),
      bytes: new Uint8Array([index === 1 ? 2 : 1]),
    }));

    await expect(documentAttachmentContexts(documents, {
      pdfModuleLoader: async () => pdfModule as never,
    })).rejects.toThrow("2.pdf could not be read as a PDF.");
    expect(started).toBe(2);
    expect(destroyedHanging).toBeGreaterThan(0);
  });
});
