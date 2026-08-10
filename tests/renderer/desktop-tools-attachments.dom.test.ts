import { describe, expect, it, vi } from "vitest";

import {
  prepareComposerAttachmentImports,
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

describe("desktop attachment preflight", () => {
  it("rejects an oversized file before reading any renderer bytes", async () => {
    const safe = fakeFile("safe.pdf", 1);
    const oversized = fakeFile(
      "oversized.pdf",
      MAX_CHAT_ATTACHMENT_BYTES + 1,
    );

    await expect(prepareComposerAttachmentImports([safe, oversized]))
      .rejects.toThrow("10 MB file limit");
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

    await expect(prepareComposerAttachmentImports([first, second, final]))
      .rejects.toThrow("20 MB turn limit");
    expect(first.arrayBuffer).not.toHaveBeenCalled();
    expect(second.arrayBuffer).not.toHaveBeenCalled();
    expect(final.arrayBuffer).not.toHaveBeenCalled();
  });

  it("reads a bounded selection only after the complete preflight passes", async () => {
    const first = fakeFile("first.pdf", 8);
    const second = fakeFile("second.pdf", 9);

    await expect(prepareComposerAttachmentImports([first, second]))
      .resolves.toEqual([
        expect.objectContaining({ name: "first.pdf", mimeType: "application/pdf" }),
        expect.objectContaining({ name: "second.pdf", mimeType: "application/pdf" }),
      ]);
    expect(first.arrayBuffer).toHaveBeenCalledOnce();
    expect(second.arrayBuffer).toHaveBeenCalledOnce();
  });
});
