import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatAttachment } from "../../src/shared/contracts";
import {
  composerMediaQueueKey,
  composerQueueHasCapacity,
  composerQueueKey,
  enqueueComposerPrompt,
  readComposerQueue,
  removeComposerQueuedPrompt,
  takeAllSessionQueuedMedia,
} from "../../src/renderer/src/components/composer/composerQueuedPrompts";
import { releaseDeletedComposerQueue } from "../../src/renderer/src/components/composer/ComposerQueuedActions";
import {
  QUEUE_OFFLINE_ERROR,
  queueComposerDraft,
} from "../../src/renderer/src/components/composer/queueComposerDraft";

const conversationId = "queued-media";

function image(id: string, name: string): ChatAttachment {
  return {
    id,
    name,
    path: id,
    mimeType: "image/png",
    size: 128,
  };
}

function seedLegacyText(id: string, content: string, createdAt = "2026-08-21T10:00:00.000Z"): void {
  const existing = JSON.parse(window.localStorage.getItem(composerQueueKey(conversationId)) ?? "[]") as unknown[];
  window.localStorage.setItem(
    composerQueueKey(conversationId),
    JSON.stringify([...existing, { id, content, createdAt, attachments: [] }]),
  );
}

function seedLegacyMedia(id: string, content: string, attachments: ChatAttachment[], createdAt = "2026-08-21T10:01:00.000Z"): void {
  const existing = JSON.parse(window.sessionStorage.getItem(composerMediaQueueKey(conversationId)) ?? "[]") as unknown[];
  window.sessionStorage.setItem(
    composerMediaQueueKey(conversationId),
    JSON.stringify([...existing, { id, content, createdAt, attachments }]),
  );
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("composer legacy local queue storage (read/delete-only)", () => {
  it("stops local writes: enqueueComposerPrompt is a no-op returning false and queueComposerDraft refuses offline", async () => {
    const attachment = image("11111111-1111-4111-8111-111111111111", "first.png");
    expect(composerQueueHasCapacity(conversationId)).toBe(false);
    expect(enqueueComposerPrompt(conversationId, "No longer written")).toBe(false);
    expect(enqueueComposerPrompt(conversationId, "With image", [attachment])).toBe(false);
    expect(readComposerQueue(conversationId)).toEqual([]);
    expect(window.localStorage.getItem(composerQueueKey(conversationId))).toBeNull();
    expect(window.sessionStorage.getItem(composerMediaQueueKey(conversationId))).toBeNull();

    const onError = vi.fn();
    const ok = await queueComposerDraft(undefined, conversationId, "Offline draft", [], () => true, onError);
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith(QUEUE_OFFLINE_ERROR);
  });

  it("still reads, drains, and releases legacy stored entries and media after conversation deletion", async () => {
    const attachment = image("55555555-5555-4555-8555-555555555555", "deleted.png");
    seedLegacyText("legacy-text", "Text only");
    seedLegacyMedia("legacy-media", "Delete with the conversation", [attachment]);

    expect(readComposerQueue(conversationId)).toMatchObject([
      { id: "legacy-text", content: "Text only", attachments: [] },
      { id: "legacy-media", content: "Delete with the conversation", attachments: [attachment] },
    ]);

    const releaseAttachment = vi.fn(async () => undefined);
    await releaseDeletedComposerQueue(conversationId, releaseAttachment);

    expect(releaseAttachment).toHaveBeenCalledExactlyOnceWith(attachment.id);
    expect(readComposerQueue(conversationId)).toEqual([]);
    expect(window.localStorage.getItem(composerQueueKey(conversationId))).toBeNull();
    expect(window.sessionStorage.getItem(composerMediaQueueKey(conversationId))).toBeNull();
  });

  it("rejects forged session attachment metadata when reading legacy entries", () => {
    const attachment = image("66666666-6666-4666-8666-666666666666", "trusted.png");
    window.sessionStorage.setItem(composerMediaQueueKey("forged"), JSON.stringify([{
      id: "forged-prompt",
      content: "Read this path",
      createdAt: "2026-08-21T10:00:00.000Z",
      attachments: [{ ...attachment, path: "/tmp/not-an-opaque-attachment-id.png" }],
    }]));

    expect(readComposerQueue("forged")).toEqual([]);
    expect(window.sessionStorage.getItem(composerMediaQueueKey("forged"))).toBeNull();
  });

  it("migrates unversioned legacy text keys so they can be explicitly moved or discarded", () => {
    const legacy = Array.from({ length: 5 }, (_, index) => ({
      id: `legacy-${index}`,
      content: `Legacy ${index}`,
      createdAt: `2026-08-21T10:0${index}:00.000Z`,
    }));
    window.localStorage.setItem(`inertia:queued-prompts:${conversationId}`, JSON.stringify(legacy));

    expect(readComposerQueue(conversationId)).toHaveLength(5);
    expect(window.localStorage.getItem(`inertia:queued-prompts:${conversationId}`)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(composerQueueKey(conversationId)) ?? "[]")).toHaveLength(5);
  });

  it("returns removed media and session media cleanly so callers can release it once", () => {
    const attachment = image("77777777-7777-4777-8777-777777777777", "remove.png");
    seedLegacyMedia("legacy-remove", "Remove me", [attachment]);
    expect(removeComposerQueuedPrompt(conversationId, "legacy-remove")).toMatchObject({
      attachments: [attachment],
    });
    expect(removeComposerQueuedPrompt(conversationId, "legacy-remove")).toBeNull();

    seedLegacyMedia("legacy-session", "Session media", [attachment]);
    expect(takeAllSessionQueuedMedia()).toMatchObject([{ content: "Session media", attachments: [attachment] }]);
    expect(readComposerQueue(conversationId)).toEqual([]);
  });
});
