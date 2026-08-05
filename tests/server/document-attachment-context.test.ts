import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatAttachment } from "../../src/shared/contracts";
import {
  awaitPdfModuleInitialization,
  createCachedPdfModuleLoader,
  documentAttachmentContexts,
  PDF_MODULE_INITIALIZATION_TIMEOUT_MS,
  pdfTextItemsToText,
} from "../../src/server/runtime/attachments/document-attachment-context";
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

const hostedWindowsCi =
  process.platform === "win32" && process.env.CI === "true";

describe("document attachment execution context", () => {
  afterEach(() => {
    vi.useRealTimers();
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
        bytes: pdfWithText("Inertia PDF context"),
      }]);

      expect(contexts).toEqual([{
        attachmentId: pdf.id,
        label: "PDF · notes.pdf",
        content: "[Page 1]\nInertia PDF context",
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
    "rejects PDFs without selectable text instead of pretending they were read",
    async () => {
      const blank = pdfWithText(" ");
      await expect(documentAttachmentContexts([{
        attachment: attachment({}),
        bytes: blank,
      }])).rejects.toThrow(/no selectable text/u);
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
