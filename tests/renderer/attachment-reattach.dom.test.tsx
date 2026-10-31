import { readFileSync } from "node:fs";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { MAX_ATTACHMENT_COUNT } from "../../src/shared/attachments";
import type { ChatAttachment } from "../../src/shared/contracts";
import type { ConversationAttachmentGalleryItem } from "../../src/shared/conversation-attachment-gallery";
import type { DesktopAttachmentImportSelection, ReattachAttachmentRequest } from "../../src/shared/desktop";
import { AttachmentsSurface } from "../../src/renderer/src/components/AttachmentsSurface";
import { ComposerAttachmentList } from "../../src/renderer/src/components/ComposerAttachmentList";
import {
  DOCUMENT_FOLLOW_UP_UNSUPPORTED,
  REATTACH_ALREADY_IN_DRAFT,
  composerAttachmentActions,
  pruneReattachedSources,
} from "../../src/renderer/src/components/composer/composerAttachmentActions";
import { COMPOSER_REATTACH_UNAVAILABLE } from "../../src/renderer/src/components/composer/composerAttachmentReattach";
import { useComposerAttachmentReattach } from "../../src/renderer/src/components/composer/useComposerAttachmentReattach";

const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherChat = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const gallery: ConversationAttachmentGalleryItem[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "shot.png", mimeType: "image/png", size: 2048 },
  { id: "22222222-2222-4222-8222-222222222222", name: "spec.pdf", mimeType: "application/pdf", size: 4096 },
  { id: "33333333-3333-4333-8333-333333333333", name: "notes.md", mimeType: "text/markdown", size: 512 },
  { id: "44444444-4444-4444-8444-444444444444", name: "archive.zip", mimeType: "application/octet-stream", size: 9000 },
];
const original = window.inertia;
let reattach: ReturnType<typeof vi.fn<(request: ReattachAttachmentRequest) => Promise<DesktopAttachmentImportSelection>>>;
let commit: ReturnType<typeof vi.fn<(batchId: string, ids: string[]) => Promise<void>>>;
let cancel: ReturnType<typeof vi.fn<(batchId: string) => Promise<void>>>;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  let sequence = 0;
  reattach = vi.fn(async ({ attachmentId }) => {
    sequence += 1;
    const item = gallery.find(({ id }) => id === attachmentId)!;
    const draftId = `draft-${sequence}`;
    return { batchId: `batch-${sequence}`, attachments: [{ ...item, id: draftId, path: draftId }] };
  });
  commit = vi.fn(async () => undefined);
  cancel = vi.fn(async () => undefined);
  window.inertia = {
    ...original,
    reattachAttachment: reattach,
    commitAttachmentImport: commit,
    cancelAttachmentImport: cancel,
  };
});

afterEach(() => {
  cleanup();
  window.inertia = original;
  vi.unstubAllGlobals();
});

function Composer({
  conversationId,
  running = false,
  imageInputUnavailableReason = null,
  initial = [],
  sources,
}: {
  conversationId: string;
  running?: boolean;
  imageInputUnavailableReason?: string | null;
  initial?: ChatAttachment[];
  sources?: Map<string, string>;
}): React.JSX.Element {
  const [attachments, setAttachments] = useState<ChatAttachment[]>(initial);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [, setImporting] = useState(false);
  const attachmentsRef = useRef(initial);
  const authorityRef = useRef({ key: conversationId, conversationId });
  const sequenceRef = useRef(0);
  const importingRef = useRef(false);
  const pendingRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const releaseRef = useRef(async (_id: string): Promise<void> => undefined);
  const submittingRef = useRef(false);
  const sourcesRef = useRef(sources ?? new Map<string, string>());
  const actions = composerAttachmentActions({
    attachmentAuthorityKey: conversationId,
    attachmentAuthorityRef: authorityRef,
    attachmentImportSequenceRef: sequenceRef,
    attachmentImportingRef: importingRef,
    attachmentsRef,
    pendingAttachmentIdsRef: pendingRef,
    blocked: false,
    conversationId,
    markEditorChanged: () => undefined,
    mountedRef,
    onChooseAttachments: async () => null,
    onImportAttachments: async () => null,
    releaseAttachmentRef: releaseRef,
    running,
    imageInputUnavailableReason,
    setAttachments,
    setAttachmentImporting: setImporting,
    setAttachmentError: setError,
    setPendingAttachmentIds: setPending,
    submittingRef,
    reattachedSourcesRef: sourcesRef,
  });
  useComposerAttachmentReattach(conversationId, actions.reattachAttachment);
  return (
    <div aria-label="Message box" role="group">
      <ComposerAttachmentList attachments={attachments} pendingAttachmentIds={pending} onRemove={actions.removeAttachment} />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function draftNames(): string[] {
  const list = screen.queryByRole("list", { name: "Attachments" });
  return list ? within(list).getAllByRole("listitem").map((item) => item.querySelector("strong")!.textContent!) : [];
}

function status(): HTMLElement {
  return screen.getByRole("status");
}

it("re-attaches a stored file into the draft by reference id, without renderer bytes", async () => {
  render(<><Composer conversationId={chat} /><AttachmentsSurface attachments={gallery} conversationId={chat} /></>);

  fireEvent.click(screen.getByRole("button", { name: "Re-attach notes.md to the message" }));

  await waitFor(() => expect(draftNames()).toEqual(["notes.md"]));
  expect(reattach).toHaveBeenCalledExactlyOnceWith({ conversationId: chat, attachmentId: gallery[2]!.id });
  expect(commit).toHaveBeenCalledExactlyOnceWith("batch-1", ["draft-1"]);
  expect(cancel).not.toHaveBeenCalled();
  expect(status()).toHaveTextContent("Added notes.md to the message.");
  // The draft entry is a fresh capability; the stored id stays with its message.
  const draft = within(screen.getByRole("group", { name: "Message box" }));
  expect(draft.getByRole("button", { name: "Preview attachment notes.md" }))
    .toHaveAttribute("data-preview-source", "inertia://bundle/attachment-preview/draft-1");
});

it("refuses a second copy of the same stored file and keeps the first", async () => {
  render(<><Composer conversationId={chat} /><AttachmentsSurface attachments={gallery} conversationId={chat} /></>);
  const button = screen.getByRole("button", { name: "Re-attach spec.pdf to the message" });
  fireEvent.click(button);
  await waitFor(() => expect(draftNames()).toEqual(["spec.pdf"]));
  fireEvent.click(button);
  await waitFor(() => expect(status()).toHaveTextContent(REATTACH_ALREADY_IN_DRAFT));
  expect(reattach).toHaveBeenCalledOnce();
  expect(draftNames()).toEqual(["spec.pdf"]);
});

it("reports a stored file that no longer exists without touching the draft", async () => {
  reattach.mockRejectedValueOnce(new Error(
    "Error invoking remote method 'inertia:reattach-attachment': Error: This file is no longer stored. Attach the original file again.",
  ));
  render(<><Composer conversationId={chat} /><AttachmentsSurface attachments={gallery} conversationId={chat} /></>);

  fireEvent.click(screen.getByRole("button", { name: "Re-attach shot.png to the message" }));

  await waitFor(() => expect(status()).toHaveTextContent("This file is no longer stored. Attach the original file again."));
  expect(screen.getByRole("alert")).toHaveTextContent("This file is no longer stored.");
  expect(draftNames()).toEqual([]);
  expect(commit).not.toHaveBeenCalled();
});

it.each([
  {
    name: "images on a route without image input",
    props: { imageInputUnavailableReason: "This model does not accept images." },
    file: "shot.png",
    message: "This model does not accept images. Images were not attached.",
  },
  { name: "documents during an active turn", props: { running: true }, file: "spec.pdf", message: DOCUMENT_FOLLOW_UP_UNSUPPORTED },
  {
    name: "a full message",
    props: {
      initial: Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, index): ChatAttachment => ({
        id: `existing-${index}`, path: `existing-${index}`, name: `${index}.txt`, mimeType: "text/plain", size: 1,
      })),
    },
    file: "notes.md",
    message: `A message supports up to ${MAX_ATTACHMENT_COUNT} files`,
  },
])("applies the composer's limits before main copies anything: $name", async ({ props, file, message }) => {
  render(<><Composer conversationId={chat} {...props} /><AttachmentsSurface attachments={gallery} conversationId={chat} /></>);

  fireEvent.click(screen.getByRole("button", { name: `Re-attach ${file} to the message` }));

  await waitFor(() => expect(status()).toHaveTextContent(message));
  expect(reattach).not.toHaveBeenCalled();
});

it("still allows images as follow-ups during an active turn", async () => {
  render(<><Composer conversationId={chat} running /><AttachmentsSurface attachments={gallery} conversationId={chat} /></>);
  fireEvent.click(screen.getByRole("button", { name: "Re-attach shot.png to the message" }));
  await waitFor(() => expect(draftNames()).toEqual(["shot.png"]));
});

it("never re-attaches into another chat's composer", async () => {
  render(<><Composer conversationId={otherChat} /><AttachmentsSurface attachments={gallery} conversationId={chat} /></>);
  fireEvent.click(screen.getByRole("button", { name: "Re-attach notes.md to the message" }));
  await waitFor(() => expect(status()).toHaveTextContent(COMPOSER_REATTACH_UNAVAILABLE));
  expect(reattach).not.toHaveBeenCalled();
  expect(draftNames()).toEqual([]);
});

it("disables re-attach without a current chat", () => {
  render(<AttachmentsSurface attachments={gallery} />);
  expect(screen.getByRole("button", { name: "Re-attach notes.md to the message" })).toBeDisabled();
});

it("opens an item menu from the pointer and the keyboard, and restores focus on Escape", async () => {
  render(<><Composer conversationId={chat} /><AttachmentsSurface attachments={gallery} conversationId={chat} /></>);
  const preview = screen.getByRole("button", { name: "Preview attachment archive.zip" });

  preview.focus();
  fireEvent.keyDown(preview, { key: "F10", shiftKey: true });
  const menu = screen.getByRole("menu", { name: "Actions for archive.zip" });
  const reattachItem = within(menu).getByRole("menuitem", { name: "Re-attach to message" });
  expect(reattachItem).toHaveFocus();
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(within(menu).getByRole("menuitem", { name: "Preview" })).toHaveFocus();
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(preview).toHaveFocus();

  fireEvent.contextMenu(preview, { clientX: 40, clientY: 50 });
  fireEvent.click(within(screen.getByRole("menu", { name: "Actions for archive.zip" }))
    .getByRole("menuitem", { name: "Re-attach to message" }));
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(draftNames()).toEqual(["archive.zip"]));
  expect(preview).toHaveFocus();
});

it("moves on from the item that opened the menu when Tab leaves it", () => {
  render(<><Composer conversationId={chat} /><AttachmentsSurface attachments={gallery} conversationId={chat} /></>);
  const preview = screen.getByRole("button", { name: "Preview attachment notes.md" });

  preview.focus();
  fireEvent.keyDown(preview, { key: "F10", shiftKey: true });
  const menu = screen.getByRole("menu", { name: "Actions for notes.md" });
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { within(menu).getByRole("menuitem", { name: "Re-attach to message" }).dispatchEvent(tab); });
  expect(tab.defaultPrevented).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();
  const focused = document.activeElement as HTMLElement;
  expect(focused).not.toBe(document.body);
  expect(focused).not.toBe(preview);
  expect(preview.compareDocumentPosition(focused) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  preview.focus();
  fireEvent.keyDown(preview, { key: "F10", shiftKey: true });
  fireEvent.keyDown(screen.getByRole("menu", { name: "Actions for notes.md" }), { key: "Tab", shiftKey: true });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(preview).toHaveFocus();
});

it("forgets where a draft copy came from once it leaves the draft", async () => {
  const sources = new Map<string, string>();
  render(<><Composer conversationId={chat} sources={sources} /><AttachmentsSurface attachments={gallery} conversationId={chat} /></>);
  const reattachNotes = screen.getByRole("button", { name: "Re-attach notes.md to the message" });
  fireEvent.click(reattachNotes);
  await waitFor(() => expect(draftNames()).toEqual(["notes.md"]));
  expect([...sources]).toEqual([["draft-1", gallery[2]!.id]]);

  fireEvent.click(screen.getByRole("button", { name: "Remove attachment notes.md" }));
  expect(draftNames()).toEqual([]);
  expect(sources.size).toBe(0);

  fireEvent.click(reattachNotes);
  await waitFor(() => expect(draftNames()).toEqual(["notes.md"]));
  expect([...sources]).toEqual([["draft-2", gallery[2]!.id]]);

  const stale = new Map([["draft-1", "a"], ["draft-2", "b"], ["draft-3", "c"]]);
  pruneReattachedSources(stale, [{ id: "draft-2" }]);
  expect([...stale]).toEqual([["draft-2", "b"]]);
});

it("previews from the item menu and dismisses it on an outside pointer", async () => {
  render(<AttachmentsSurface attachments={gallery} conversationId={chat} />);
  const preview = screen.getByRole("button", { name: "Preview attachment notes.md" });
  fireEvent.contextMenu(preview);
  act(() => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.keyDown(preview, { key: "ContextMenu" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Preview" }));
  expect(await screen.findByRole("dialog", { name: "notes.md" })).toBeInTheDocument();
});

it("filters the gallery by images, documents and text", () => {
  render(<AttachmentsSurface attachments={gallery} conversationId={chat} />);
  const list = (): string[] => within(screen.getByRole("list", { name: "Chat attachments" }))
    .getAllByRole("listitem").map((item) => item.querySelector("strong")!.textContent!);
  const filters = screen.getByRole("group", { name: "Show attachments" });
  expect(within(filters).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  expect(list()).toEqual(["shot.png", "spec.pdf", "notes.md", "archive.zip"]);

  fireEvent.click(within(filters).getByRole("button", { name: "Images" }));
  expect(within(filters).getByRole("button", { name: "Images" })).toHaveAttribute("aria-pressed", "true");
  expect(list()).toEqual(["shot.png"]);
  fireEvent.click(within(filters).getByRole("button", { name: "Documents" }));
  expect(list()).toEqual(["spec.pdf", "archive.zip"]);
  fireEvent.click(within(filters).getByRole("button", { name: "Text" }));
  expect(list()).toEqual(["notes.md"]);
});

it("explains an empty filter result", () => {
  render(<AttachmentsSurface attachments={[gallery[0]!]} conversationId={chat} />);
  fireEvent.click(screen.getByRole("button", { name: "Text" }));
  expect(screen.getByText("No text files")).toBeVisible();
  expect(screen.queryByRole("list", { name: "Chat attachments" })).toBeNull();
});

it("keeps each gallery tile's thumbnail, name and size above its re-attach action", () => {
  const css = readFileSync("src/renderer/src/components/AttachmentsSurface.css", "utf8").replaceAll("\r\n", "\n");
  const rule = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };
  // A side-by-side action column once squeezed the preview tile to zero width.
  expect(rule(".attachments-surface .sent-attachment[data-attachment-actions]"))
    .toMatch(/grid-template-columns: minmax\(0, 1fr\);/u);
  expect(rule(".attachments-surface .environment-attachments[data-expanded=\"true\"] .sent-attachments"))
    .toMatch(/minmax\(min\(128px, 100%\), 1fr\)/u);
  const size = rule(".attachments-surface .environment-attachments[data-expanded=\"true\"] .sent-attachment-copy small");
  expect(size).toMatch(/position: static;/u);
  expect(size).toMatch(/clip: auto;/u);
  // Theme tokens only, so light and dark themes both apply.
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/iu);

  render(<AttachmentsSurface attachments={[{ id: "55555555-5555-4555-8555-555555555555", name: "preview.png", mimeType: "image/png", size: 68 }]} conversationId={chat} />);
  const item = within(screen.getByRole("list", { name: "Chat attachments" })).getByRole("listitem");
  const [tile, action] = [...item.children];
  expect(tile).toHaveAccessibleName("Preview attachment preview.png");
  expect(tile).toHaveTextContent("preview.png");
  expect(tile).toHaveTextContent("PNG image · 68 B");
  expect(action).toHaveAccessibleName("Re-attach preview.png to the message");
});
