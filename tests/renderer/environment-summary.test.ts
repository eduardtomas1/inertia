import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT,
  buildWorkspaceSurfaceSummary,
} from "../../src/renderer/src/utils/environmentSummary";
import type {
  ChatMessage,
} from "../../src/shared/contracts";

const now = "2026-08-12T12:00:00.000Z";

function message(id: string, name: string): ChatMessage {
  return {
    id,
    conversationId: "conversation-1",
    turnId: `turn-${id}`,
    role: "user",
    content: "Review this.",
    attachments: [{
      id: `attachment-${id}`,
      name,
      path: `/private/${name}`,
      mimeType: name.endsWith(".pdf") ? "application/pdf" : "image/png",
      size: 128,
    }],
    createdAt: now,
  };
}

function attachmentGallerySummary(messages: readonly ChatMessage[], attachmentGallery?: Parameters<typeof buildWorkspaceSurfaceSummary>[0]["attachmentGallery"], liveMessages?: readonly ChatMessage[]) {
  return buildWorkspaceSurfaceSummary({
    projectId: "project-1",
    conversationId: "conversation-1",
    connectionStatus: "online",
    workspaceGitStatus: null,
    runs: [],
    messages,
    attachmentGallery,
    liveMessages,
  });
}

describe("environment summary projection", () => {
  it("uses bounded gallery metadata independently of the loaded transcript page", () => {
    const gallery = [{ id: "old-image", name: "old.png", mimeType: "image/png" as const, size: 42 }];
    expect(attachmentGallerySummary([], gallery).attachments).toBe(gallery);
    expect(attachmentGallerySummary([message("new", "new.png")], []).attachments).toEqual([]);
  });

  it("adds live follow-up images immediately without promoting older search pages", () => {
    const historical = [message("old-search-result", "old.png")];
    const live = [message("follow-up", "new.png")];
    const current = Array.from({ length: 60 }, (_, index) => ({ id: `current-${index}`,
      name: `current-${index}.png`, mimeType: "image/png" as const, size: 42 }));
    const summary = attachmentGallerySummary([...historical, ...live], current, live);
    expect(summary.attachments).toHaveLength(60);
    expect(summary.attachments.map(({ id }) => id)).toEqual([
      "attachment-follow-up", ...current.slice(0, 59).map(({ id }) => id),
    ]);
    expect(attachmentGallerySummary(historical, current, live).attachments).toBe(summary.attachments);
    expect(attachmentGallerySummary(live, [], live).attachments).toEqual([{
      id: "attachment-follow-up", name: "new.png", mimeType: "image/png", size: 128,
    }]);
    expect(JSON.stringify(summary.attachments)).not.toContain("/private/");
    const refreshed = [summary.attachments[0]!, ...current.slice(0, 59)];
    expect(attachmentGallerySummary(live, refreshed, live).attachments).toEqual(refreshed);
  });
  it("collects the newest attachments for the gallery and caps the scan", () => {
    const messages = Array.from(
      { length: ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT + 8 },
      (_, index) => message(`m-${index}`, `shot-${index}.png`),
    );
    const summary = attachmentGallerySummary(messages);

    expect(summary.attachments).toHaveLength(
      ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT,
    );
    // Newest first, so the last message leads and the oldest fall off.
    expect(summary.attachments[0]!.name)
      .toBe(`shot-${messages.length - 1}.png`);
    expect(summary.attachments.map(({ name }) => name)).not.toContain(
      "shot-0.png",
    );
    expect(JSON.stringify(summary)).not.toContain("/private/");
  });

  it("reuses the attachment projection while the transcript is unchanged", () => {
    const messages = [message("m-1", "reference.png")];

    const first = attachmentGallerySummary(messages);
    const second = attachmentGallerySummary(messages);

    expect(second.attachments).toBe(first.attachments);
    expect(attachmentGallerySummary([...messages]).attachments)
      .not.toBe(first.attachments);
  });
});
