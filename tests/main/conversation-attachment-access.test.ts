import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: { openPath: vi.fn() },
}));

import type { AttachmentRegistry } from "../../src/main/attachment-registry";
import * as attachmentImport from "../../src/main/attachment-import";
import {
  openConversationAttachments,
  resolveAttachmentPreviewResponse,
} from "../../src/main/conversation-attachment-access";
import type { ConversationAttachmentStoreAnyOperationRunner } from "../../src/node/conversation-attachment-store-child";
import { metadataFor } from "../../src/node/conversation-attachment-store-metadata";
import {
  CHAT_ATTACHMENT_MIME_TYPES,
  type ChatAttachmentMimeType,
} from "../../src/shared/attachments";

const attachmentId = "11111111-1111-4111-8111-111111111111";
const cleanups: (() => Promise<void>)[] = [];

async function retainedPreview(metadataPatch: Record<string, unknown> = {}) {
  const bytes = Buffer.from("Retained attachment");
  const metadata = metadataFor({
    attachment: { id: attachmentId, name: "reference.txt", mimeType: "text/plain", size: bytes.length, path: "/unused" },
    bytes,
  });
  const runner = vi.fn(() => ({
    result: Promise.resolve({ missing: false, bytes, metadata: JSON.stringify({ ...metadata, ...metadataPatch }) }),
    stopped: Promise.resolve(),
  })) as unknown as ConversationAttachmentStoreAnyOperationRunner;
  const directory = await mkdtemp(join(tmpdir(), "inertia-retained-preview-"));
  const store = await openConversationAttachments(directory, runner);
  cleanups.push(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, runner, bytes };
}

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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("opaque conversation attachment preview responses", () => {
  it("serves utility-validated retained content without structural parsing in main", async () => {
    const parser = vi.spyOn(attachmentImport, "validateAttachmentImport")
      .mockImplementation(() => { throw new Error("Main must not parse attachment structure."); });
    const { store, runner, bytes } = await retainedPreview();

    const response = await resolveAttachmentPreviewResponse(null, Promise.resolve(store), attachmentId);
    expect(await response?.text()).toBe(bytes.toString());
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ operation: "read", id: attachmentId }), expect.any(AbortSignal));
    expect(parser).not.toHaveBeenCalled();
  });

  it.each([
    { id: "22222222-2222-4222-8222-222222222222" },
    { mimeType: "application/pdf" },
    { size: 1 },
    { digest: "0".repeat(64) },
  ])("keeps independent main receipt checks for %j", async (patch) => {
    const { store } = await retainedPreview(patch);
    await expect(resolveAttachmentPreviewResponse(null, Promise.resolve(store), attachmentId)).resolves.toBeNull();
  });

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
