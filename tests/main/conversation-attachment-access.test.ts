import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: { openPath: vi.fn() },
}));

import type { AttachmentRegistry } from "../../src/main/attachment-registry";
import { resolveAttachmentPreviewResponse } from "../../src/main/conversation-attachment-access";
import {
  CHAT_ATTACHMENT_MIME_TYPES,
  type ChatAttachmentMimeType,
} from "../../src/shared/attachments";

const attachmentId = "11111111-1111-4111-8111-111111111111";

function registryPreview(mimeType: ChatAttachmentMimeType): AttachmentRegistry {
  const bytes = Buffer.from(`preview:${mimeType}`, "utf8");
  return {
    preview: vi.fn(async () => ({
      bytes,
      mimeType,
      size: bytes.byteLength,
    })),
  } as unknown as AttachmentRegistry;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("opaque conversation attachment preview responses", () => {
  it.each(CHAT_ATTACHMENT_MIME_TYPES)(
    "serves a revalidated %s attachment through the private preview route",
    async (mimeType) => {
      const response = await resolveAttachmentPreviewResponse(
        registryPreview(mimeType),
        null,
        attachmentId,
      );

      expect(response).not.toBeNull();
      expect(response?.headers.get("content-type")).toBe(mimeType);
      expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response?.headers.get("cache-control")).toBe("no-store");
      expect(await response?.text()).toBe(`preview:${mimeType}`);
    },
  );

  it("returns no response when neither attachment store owns the capability", async () => {
    const temporary = {
      preview: vi.fn(async () => null),
    } as unknown as AttachmentRegistry;

    await expect(resolveAttachmentPreviewResponse(
      temporary,
      null,
      attachmentId,
    )).resolves.toBeNull();
  });
});
