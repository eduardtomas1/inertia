import { describe, expect, it, vi } from "vitest";

import {
  type ComposerAttachmentImportBatch,
  importComposerAttachmentFilesSequentially,
  preflightComposerAttachmentFiles,
} from "../../src/renderer/src/hooks/useDesktopTools";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
} from "../../src/shared/attachments";

function fakeFile(name: string, size: number) {
  return {
    name,
    size,
    type: "application/pdf",
    arrayBuffer: vi.fn(async () => new ArrayBuffer(1)),
  } as unknown as File & { arrayBuffer: ReturnType<typeof vi.fn> };
}

const batchId = "11111111-1111-4111-8111-111111111111";

function importBatch(
  importOne: ComposerAttachmentImportBatch["importOne"],
): ComposerAttachmentImportBatch & {
  begin: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  return {
    begin: vi.fn(async () => batchId),
    importOne,
    cancel: vi.fn(async () => undefined),
  };
}

describe("desktop attachment preflight", () => {
  it("rejects an oversized file before reading any renderer bytes", async () => {
    const safe = fakeFile("safe.pdf", 1);
    const oversized = fakeFile(
      "oversized.pdf",
      MAX_CHAT_ATTACHMENT_BYTES + 1,
    );

    expect(() => preflightComposerAttachmentFiles([safe, oversized]))
      .toThrow("10 MB file limit");
    expect(safe.arrayBuffer).not.toHaveBeenCalled();
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects an oversized aggregate before reading files in parallel", async () => {
    const first = fakeFile("first.pdf", MAX_CHAT_ATTACHMENT_BYTES);
    const second = fakeFile("second.pdf", MAX_CHAT_ATTACHMENT_BYTES);
    const final = fakeFile(
      "final.pdf",
      MAX_CHAT_ATTACHMENT_TOTAL_BYTES
        - (2 * MAX_CHAT_ATTACHMENT_BYTES)
        + 1,
    );

    expect(() => preflightComposerAttachmentFiles([first, second, final]))
      .toThrow("20 MB turn limit");
    expect(first.arrayBuffer).not.toHaveBeenCalled();
    expect(second.arrayBuffer).not.toHaveBeenCalled();
    expect(final.arrayBuffer).not.toHaveBeenCalled();
  });

  it("accepts a bounded selection without reading renderer bytes", () => {
    const first = fakeFile("first.pdf", 8);
    const second = fakeFile("second.pdf", 9);

    expect(() => preflightComposerAttachmentFiles([first, second]))
      .not.toThrow();
    expect(first.arrayBuffer).not.toHaveBeenCalled();
    expect(second.arrayBuffer).not.toHaveBeenCalled();
  });

  it("imports renderer files one at a time instead of retaining the batch", async () => {
    const events: string[] = [];
    const files = ["first.pdf", "second.pdf", "third.pdf"].map((name, index) => ({
      name,
      size: 1,
      type: "application/pdf",
      arrayBuffer: vi.fn(async () => {
        events.push(`read:${name}`);
        return Uint8Array.of(index).buffer;
      }),
    } as unknown as File));
    let activeImports = 0;
    let maximumImports = 0;

    const batch = importBatch(async (_batchId, { name }) => {
        activeImports += 1;
        maximumImports = Math.max(maximumImports, activeImports);
        events.push(`import:${name}`);
        await Promise.resolve();
        activeImports -= 1;
        const index = events.filter((event) => event.startsWith("import:"))
          .length;
        return [{
          id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
          name,
          path: "opaque",
          mimeType: "application/pdf",
          size: 1,
        }];
      });
    const imported = await importComposerAttachmentFilesSequentially(files, batch);

    expect(imported.attachments).toHaveLength(3);
    expect(imported.batchId).toBe(batchId);
    expect(batch.begin).toHaveBeenCalledOnce();
    expect(batch.cancel).not.toHaveBeenCalled();
    expect(maximumImports).toBe(1);
    expect(events).toEqual([
      "read:first.pdf",
      "import:first.pdf",
      "read:second.pdf",
      "import:second.pdf",
      "read:third.pdf",
      "import:third.pdf",
    ]);
  });

  it("deduplicates byte-identical renderer files without retaining the batch", async () => {
    const files = ["first.pdf", "renamed.pdf"].map((name) => ({
      name,
      size: 1,
      type: "application/pdf",
      arrayBuffer: vi.fn(async () => Uint8Array.of(7).buffer),
    } as unknown as File & { arrayBuffer: ReturnType<typeof vi.fn> }));
    const importOne = vi.fn(async (_batchId: string, { name }: { name: string }) => [{
      id: "11111111-1111-4111-8111-111111111111",
      name,
      path: "opaque",
      mimeType: "application/pdf" as const,
      size: 1,
    }]);

    const batch = importBatch(importOne);
    const imported = await importComposerAttachmentFilesSequentially(files, batch);

    expect(imported.attachments).toHaveLength(1);
    expect(imported.attachments[0]?.name).toBe("first.pdf");
    expect(importOne).toHaveBeenCalledTimes(1);
    expect(files[0].arrayBuffer).toHaveBeenCalledOnce();
    expect(files[1].arrayBuffer).toHaveBeenCalledOnce();
  });

  it("releases earlier renderer imports after a later validation failure", async () => {
    const files = ["first.pdf", "unsafe.pdf"].map((name, index) => ({
      name,
      size: 1,
      type: "application/pdf",
      arrayBuffer: vi.fn(async () => Uint8Array.of(index).buffer),
    } as unknown as File));
    const batch = importBatch(async (_batchId, { name }) => {
      if (name === "unsafe.pdf") throw new Error("unsafe fixture");
      return [{
        id: "11111111-1111-4111-8111-111111111111",
        name,
        path: "opaque",
        mimeType: "application/pdf",
        size: 1,
      }];
    });

    await expect(importComposerAttachmentFilesSequentially(
      files,
      batch,
    )).rejects.toThrow("unsafe fixture");

    expect(batch.cancel).toHaveBeenCalledExactlyOnceWith(batchId);
  });

  it("cancels the privileged batch when a renderer file changes before import", async () => {
    const file = {
      name: "changed.pdf",
      size: 1,
      type: "application/pdf",
      arrayBuffer: vi.fn(async () => new ArrayBuffer(2)),
    } as unknown as File;
    const importOne = vi.fn();
    const batch = importBatch(importOne);

    await expect(importComposerAttachmentFilesSequentially([file], batch))
      .rejects.toThrow("changed while it was being imported");

    expect(importOne).not.toHaveBeenCalled();
    expect(batch.cancel).toHaveBeenCalledExactlyOnceWith(batchId);
  });
});
