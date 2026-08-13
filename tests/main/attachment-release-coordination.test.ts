import { describe, expect, it, vi } from "vitest";

import { releaseRendererAttachment } from "../../src/main/attachment-release-coordination";

const attachmentId = "11111111-1111-4111-8111-111111111111";

describe("renderer attachment release coordination", () => {
  it("transfers cleanup intent when a runtime claim crosses the release", async () => {
    const releaseFromRenderer = vi.fn(async () => false);
    const deferAttachmentRelease = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await releaseRendererAttachment(
      attachmentId,
      { releaseFromRenderer },
      { deferAttachmentRelease },
    );

    expect(releaseFromRenderer).toHaveBeenCalledExactlyOnceWith(attachmentId);
    expect(deferAttachmentRelease).toHaveBeenCalledTimes(2);
  });

  it("does not start registry deletion for an existing runtime claim", async () => {
    const releaseFromRenderer = vi.fn(async () => true);
    const deferAttachmentRelease = vi.fn(() => true);

    await releaseRendererAttachment(
      attachmentId,
      { releaseFromRenderer },
      { deferAttachmentRelease },
    );

    expect(releaseFromRenderer).not.toHaveBeenCalled();
    expect(deferAttachmentRelease).toHaveBeenCalledExactlyOnceWith(attachmentId);
  });

  it("deletes after a crossing runtime claim already relinquished", async () => {
    const releaseFromRenderer = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const deferAttachmentRelease = vi.fn(() => false);

    await releaseRendererAttachment(
      attachmentId,
      { releaseFromRenderer },
      { deferAttachmentRelease },
    );

    expect(releaseFromRenderer).toHaveBeenCalledTimes(2);
    expect(deferAttachmentRelease).toHaveBeenCalledTimes(2);
  });
});
