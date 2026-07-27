import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatAttachment } from "../../src/shared/contracts";
import { MAX_CHAT_ATTACHMENT_TOTAL_BYTES } from "../../src/shared/contracts";
import { ComposerAttachmentList } from "../../src/renderer/src/components/ComposerAttachmentList";
import {
  attachmentPreviewUrl,
  documentAttachmentSendBoundary,
  formatAttachmentSize,
  mergeComposerAttachments,
} from "../../src/renderer/src/utils/composerAttachments";

function attachment(
  id: string,
  update: Partial<ChatAttachment> = {},
): ChatAttachment {
  return {
    id,
    name: "preview.png",
    path: `/private/tmp/${id}.png`,
    mimeType: "image/png",
    size: 1_024,
    ...update,
  };
}

describe("composer attachment previews", () => {
  it("deduplicates current attachments and keeps the eight-item boundary", () => {
    const current = [attachment("one")];
    const incoming = [
      attachment("same-path", { path: current[0]!.path, name: "other.png" }),
      attachment("same-metadata", { path: "/private/tmp/other.png" }),
      ...Array.from({ length: 9 }, (_, index) =>
        attachment(`new-${index}`, {
          name: `new-${index}.png`,
          path: `/private/tmp/new-${index}.png`,
          size: 2_000 + index,
        })),
    ];

    const result = mergeComposerAttachments(current, incoming);

    expect(result.attachments).toHaveLength(8);
    expect(result.rejected).toHaveLength(4);
    expect(new Set(result.attachments.map(({ id }) => id)).size).toBe(8);
  });

  it("enforces the total byte budget across separate import batches", () => {
    const current = [attachment("first", {
      size: MAX_CHAT_ATTACHMENT_TOTAL_BYTES / 2 + 1,
    })];
    const incoming = [attachment("second", {
      name: "second.png",
      path: "/private/tmp/second.png",
      size: MAX_CHAT_ATTACHMENT_TOTAL_BYTES / 2,
    })];

    expect(mergeComposerAttachments(current, incoming)).toEqual({
      attachments: current,
      rejected: incoming,
    });
  });

  it("uses opaque same-origin thumbnail URLs and never document or raw file URLs", () => {
    const image = attachment("11111111-1111-4111-8111-111111111111");
    const document = attachment("22222222-2222-4222-8222-222222222222", {
      name: "notes.pdf",
      path: "/Users/person/secret/notes.pdf",
      mimeType: "application/pdf",
    });

    expect(attachmentPreviewUrl(image)).toBe(
      "inertia://bundle/attachment-preview/11111111-1111-4111-8111-111111111111",
    );
    expect(attachmentPreviewUrl(image)).not.toContain(image.path);
    expect(attachmentPreviewUrl(document)).toBeNull();
  });

  it("renders real image elements, safe document metadata, and obvious accessible removal", () => {
    const image = attachment("11111111-1111-4111-8111-111111111111");
    const document = attachment("22222222-2222-4222-8222-222222222222", {
      name: "notes.pdf",
      path: "/Users/person/secret/notes.pdf",
      mimeType: "application/pdf",
      size: 2_048,
    });
    const html = renderToStaticMarkup(createElement(ComposerAttachmentList, {
      attachments: [image, document],
      onRemove: () => undefined,
    }));

    expect(html).toContain("<img");
    expect(html).toContain("PNG image");
    expect(html).toContain("PDF document");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("Remove attachment notes.pdf");
    expect(html).toContain(">Remove</span>");
    expect(html).not.toContain(document.path);
    expect(html).not.toContain("file://");
  });

  it("blocks unsupported document sending honestly while preserving image sends", () => {
    expect(documentAttachmentSendBoundary([attachment("image")])).toBeNull();
    expect(documentAttachmentSendBoundary([
      attachment("document", {
        name: "notes.txt",
        mimeType: "text/plain",
      }),
    ])).toMatch(/cannot read documents/u);
  });

  it("keeps attachment layout bounded without permitting raw file URLs", () => {
    const css = readFileSync(
      new URL("../../src/renderer/src/styles.css", import.meta.url),
      "utf8",
    );
    const html = readFileSync(
      new URL("../../src/renderer/index.html", import.meta.url),
      "utf8",
    );

    expect(css).toMatch(/\.composer-attachments\s*\{[^}]*display:\s*grid[^}]*max-height:\s*calc\(var\(--composer-preview-size\) \+ var\(--composer-preview-size\) \+ 12px\)[^}]*overflow-y:\s*auto/su);
    expect(css).toMatch(/\.composer-attachment\s*\{[^}]*min-height:\s*var\(--composer-preview-size\)[^}]*border:\s*0;[^}]*background:\s*transparent/su);
    expect(css).toMatch(/\.composer-attachment-preview\s*\{[^}]*width:\s*var\(--composer-preview-size\);[^}]*height:\s*var\(--composer-preview-size\)/su);
    expect(css).toMatch(/\.composer-attachment-preview img\s*\{[^}]*object-fit:\s*cover/su);
    // Development loads the renderer over HTTP, so its privileged preview is
    // cross-origin even though packaged windows use inertia://bundle.
    expect(html).toContain("img-src 'self' inertia: data: blob:");
    expect(html).not.toMatch(/img-src[^;]*file:/u);
  });

  it("formats bounded metadata compactly", () => {
    expect(formatAttachmentSize(42)).toBe("42 B");
    expect(formatAttachmentSize(1_024)).toBe("1.0 KB");
    expect(formatAttachmentSize(1_572_864)).toBe("1.5 MB");
  });
});
