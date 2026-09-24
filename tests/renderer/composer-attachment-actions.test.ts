import { describe, expect, it, vi } from "vitest";

import type { ChatAttachment } from "../../src/shared/contracts";
import {
  composerAttachmentActions,
  DOCUMENT_FOLLOW_UP_UNSUPPORTED,
} from "../../src/renderer/src/components/composer/composerAttachmentActions";

function file(name: string): File {
  return new File(["x"], name, { type: "application/octet-stream" });
}

function actions(overrides: { running?: boolean; imageInputUnavailableReason?: string | null } = {}) {
  const errors: Array<string | null> = [];
  const onImportAttachments = vi.fn<(files: File[]) => Promise<null>>(async () => null);
  const attachmentsRef = { current: [] as ChatAttachment[] };
  const created = composerAttachmentActions({
    attachmentAuthorityKey: "conversation-1",
    attachmentAuthorityRef: { current: { key: "conversation-1", conversationId: "conversation-1" } },
    attachmentImportSequenceRef: { current: 0 },
    attachmentImportingRef: { current: false },
    attachmentsRef,
    pendingAttachmentIdsRef: { current: new Set<string>() },
    blocked: false,
    conversationId: "conversation-1",
    markEditorChanged: () => undefined,
    mountedRef: { current: true },
    onChooseAttachments: vi.fn(async () => null),
    onImportAttachments,
    releaseAttachmentRef: { current: vi.fn(async () => undefined) },
    running: overrides.running ?? false,
    imageInputUnavailableReason: overrides.imageInputUnavailableReason ?? null,
    setAttachments: () => undefined,
    setAttachmentImporting: () => undefined,
    setAttachmentError: (value) => {
      errors.push(typeof value === "function" ? value(errors.at(-1) ?? null) : value);
    },
    setPendingAttachmentIds: () => undefined,
    submittingRef: { current: false },
  });
  return { created, errors, onImportAttachments };
}

describe("composer attachment imports", () => {
  it("names unsupported files and still imports the supported ones", async () => {
    const { created, errors, onImportAttachments } = actions();
    await created.importAttachments([file("notes.docx"), file("shot.png"), file("logo.svg")]);
    expect(onImportAttachments).toHaveBeenCalledOnce();
    expect(onImportAttachments.mock.calls[0]![0].map((entry) => entry.name)).toEqual(["shot.png"]);
    expect(errors.at(-1)).toBe(
      "Unsupported file type: notes.docx, logo.svg. "
      + "Supported types: PNG, JPEG, WebP, GIF, PDF, TXT, Markdown, CSV, JSON, XLSX and XLS.",
    );
  });

  it("does not start an import when every file is unsupported", async () => {
    const { created, errors, onImportAttachments } = actions();
    await created.importAttachments([file("a.heic"), file("b.tiff"), file("c.bmp"), file("d.avif"), file("e.ico")]);
    expect(onImportAttachments).not.toHaveBeenCalled();
    expect(errors.at(-1)).toContain("Unsupported file type: a.heic, b.tiff, c.bmp and 2 more.");
  });

  it("explains that documents cannot follow up while the agent is working", async () => {
    const { created, errors, onImportAttachments } = actions({ running: true });
    await created.importAttachments([file("report.pdf")]);
    expect(onImportAttachments).not.toHaveBeenCalled();
    expect(errors.at(-1)).toBe(DOCUMENT_FOLLOW_UP_UNSUPPORTED);

    await created.importAttachments([file("report.pdf"), file("shot.png")]);
    expect(onImportAttachments).toHaveBeenCalledOnce();
    expect(onImportAttachments.mock.calls[0]![0].map((entry) => entry.name)).toEqual(["shot.png"]);
  });

  it("keeps the existing image refusal message for text-only routes", async () => {
    const { created, errors, onImportAttachments } = actions({
      imageInputUnavailableReason: "This model does not accept images.",
    });
    await created.importAttachments([file("shot.png")]);
    expect(onImportAttachments).not.toHaveBeenCalled();
    expect(errors.at(-1)).toBe("This model does not accept images. Images were not attached.");
  });
});
