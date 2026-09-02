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

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("composer queued prompt storage", () => {
  it("caps new admission at three while preserving each entry's media", () => {
    const first = image("11111111-1111-4111-8111-111111111111", "first.png");
    const second = image("22222222-2222-4222-8222-222222222222", "second.png");
    const third = image("33333333-3333-4333-8333-333333333333", "third.png");

    expect(enqueueComposerPrompt(conversationId, "A", [first])).toBe(true);
    expect(enqueueComposerPrompt(conversationId, "B", [second])).toBe(true);
    expect(enqueueComposerPrompt(conversationId, "C", [third])).toBe(true);
    expect(enqueueComposerPrompt(conversationId, "D")).toBe(false);

    expect(composerQueueHasCapacity(conversationId)).toBe(false);
    expect(readComposerQueue(conversationId)).toMatchObject([
      { content: "A", attachments: [first] },
      { content: "B", attachments: [second] },
      { content: "C", attachments: [third] },
    ]);
    expect(window.localStorage.getItem(composerQueueKey(conversationId))).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem(
      composerMediaQueueKey(conversationId),
    ) ?? "[]")).toHaveLength(3);
  });

  it("keeps durable text separate from renderer-session media", () => {
    const attachment = image(
      "44444444-4444-4444-8444-444444444444",
      "queued.png",
    );
    expect(enqueueComposerPrompt(conversationId, "Text only")).toBe(true);
    expect(enqueueComposerPrompt(conversationId, "With image", [attachment])).toBe(true);

    expect(JSON.parse(window.localStorage.getItem(
      composerQueueKey(conversationId),
    ) ?? "[]")).toMatchObject([{ content: "Text only", attachments: [] }]);
    expect(JSON.parse(window.sessionStorage.getItem(
      composerMediaQueueKey(conversationId),
    ) ?? "[]")).toMatchObject([{
      content: "With image",
      attachments: [attachment],
    }]);

    expect(takeAllSessionQueuedMedia()).toMatchObject([{
      content: "With image",
      attachments: [attachment],
    }]);
    expect(readComposerQueue(conversationId)).toMatchObject([{
      content: "Text only",
      attachments: [],
    }]);
  });

  it("drains text and releases media after conversation deletion", async () => {
    const attachment = image(
      "55555555-5555-4555-8555-555555555555",
      "deleted.png",
    );
    expect(enqueueComposerPrompt(conversationId, "Text only")).toBe(true);
    expect(enqueueComposerPrompt(
      conversationId,
      "Delete with the conversation",
      [attachment],
    )).toBe(true);
    const releaseAttachment = vi.fn(async () => undefined);

    await releaseDeletedComposerQueue(conversationId, releaseAttachment);

    expect(releaseAttachment).toHaveBeenCalledExactlyOnceWith(attachment.id);
    expect(readComposerQueue(conversationId)).toEqual([]);
    expect(window.localStorage.getItem(composerQueueKey(conversationId))).toBeNull();
    expect(window.sessionStorage.getItem(
      composerMediaQueueKey(conversationId),
    )).toBeNull();
  });

  it("rejects duplicate capabilities and forged session metadata", () => {
    const attachment = image(
      "55555555-5555-4555-8555-555555555555",
      "trusted.png",
    );
    expect(enqueueComposerPrompt(conversationId, "First", [attachment])).toBe(true);
    expect(enqueueComposerPrompt(conversationId, "Duplicate", [attachment])).toBe(false);

    window.sessionStorage.setItem(composerMediaQueueKey("forged"), JSON.stringify([{
      id: "forged-prompt",
      content: "Read this path",
      createdAt: "2026-08-21T10:00:00.000Z",
      attachments: [{
        ...attachment,
        id: "66666666-6666-4666-8666-666666666666",
        path: "/tmp/not-an-opaque-attachment-id.png",
      }],
    }]));

    expect(readComposerQueue("forged")).toEqual([]);
    expect(window.sessionStorage.getItem(composerMediaQueueKey("forged"))).toBeNull();
  });

  it("migrates and preserves legacy text overflow so it can drain", () => {
    const legacy = Array.from({ length: 5 }, (_, index) => ({
      id: `legacy-${index}`,
      content: `Legacy ${index}`,
      createdAt: `2026-08-21T10:0${index}:00.000Z`,
    }));
    window.localStorage.setItem(
      `inertia:queued-prompts:${conversationId}`,
      JSON.stringify(legacy),
    );

    expect(readComposerQueue(conversationId)).toHaveLength(5);
    expect(composerQueueHasCapacity(conversationId)).toBe(false);
    expect(window.localStorage.getItem(
      `inertia:queued-prompts:${conversationId}`,
    )).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(
      composerQueueKey(conversationId),
    ) ?? "[]")).toHaveLength(5);
  });

  it("returns removed media so callers can release it exactly once", () => {
    const attachment = image(
      "77777777-7777-4777-8777-777777777777",
      "remove.png",
    );
    expect(enqueueComposerPrompt(conversationId, "Remove me", [attachment])).toBe(true);
    const [queued] = readComposerQueue(conversationId);

    expect(removeComposerQueuedPrompt(conversationId, queued.id)).toMatchObject({
      attachments: [attachment],
    });
    expect(removeComposerQueuedPrompt(conversationId, queued.id)).toBeNull();
  });
});
