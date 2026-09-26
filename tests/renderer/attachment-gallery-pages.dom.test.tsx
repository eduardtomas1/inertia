import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentsSurface } from "../../src/renderer/src/components/AttachmentsSurface";
import type { AttachmentGalleryItem, AttachmentGalleryResult } from "../../src/shared/attachment-gallery";
import { deferred } from "./composer-fixtures";

const conversationId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const image = (index: number): AttachmentGalleryItem => ({ id: crypto.randomUUID(), name: `gallery-${index}.png`, mimeType: "image/png", size: 1024 });
const page = (attachments: AttachmentGalleryItem[], olderCursor: string | null = null, newerCursor: string | null = null, id = conversationId): AttachmentGalleryResult => ({
  kind: "conversation.attachments", conversationId: id, attachments, olderCursor, newerCursor,
});
beforeEach(() => { vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} }); });
afterEach(() => vi.unstubAllGlobals());

describe("independent attachment gallery pages", () => {
  it("renders all sixty older-chat images without requesting full transcript data or loading offscreen originals", async () => {
    const images = Array.from({ length: 60 }, (_, index) => image(59 - index));
    const sendCommand = vi.fn(async (command) => ({ type: "request.result" as const, requestId: command.requestId, result: page(images) }));
    const view = render(<AttachmentsSurface conversationId={conversationId} attachments={images.slice(0, 8)} sendCommand={sendCommand} />);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Chat attachments" })).getAllByRole("listitem")).toHaveLength(60));
    expect(screen.getByRole("button", { name: "Preview attachment gallery-0.png" })).toBeInTheDocument();
    expect(view.container.querySelectorAll("img")).toHaveLength(0);
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "conversation.attachments.list", payload: { conversationId } }));
    expect(screen.queryByRole("navigation", { name: "Attachment pages" })).toBeNull();
    view.rerender(<AttachmentsSurface conversationId={conversationId} attachments={images.slice(0, 8)} sendCommand={sendCommand} />);
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("replaces each bounded page and offers newer and newest navigation", async () => {
    const latest = Array.from({ length: 60 }, (_, index) => image(index + 60));
    const old = Array.from({ length: 60 }, (_, index) => image(index));
    const requestPage = vi.fn(async (cursor?: string) => cursor === "older" ? page(old, null, "newer") : page(latest, "older"));
    render(<AttachmentsSurface conversationId={conversationId} attachments={[]} requestPage={requestPage} />);
    await screen.findByRole("button", { name: "Older attachments" });
    fireEvent.click(screen.getByRole("button", { name: "Older attachments" }));
    await screen.findByRole("button", { name: "Preview attachment gallery-0.png" });
    expect(screen.queryByRole("button", { name: "Preview attachment gallery-60.png" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Chat attachments" })).getAllByRole("listitem")).toHaveLength(60);
    fireEvent.click(screen.getByRole("button", { name: "Newer attachments" }));
    await screen.findByRole("button", { name: "Preview attachment gallery-60.png" });
    expect(requestPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "older", "newer"]);
  });

  it("rejects late cross-chat pages and reloads newest metadata on runtime replacement", async () => {
    const pending = deferred<AttachmentGalleryResult>();
    const first = vi.fn(() => pending.promise);
    const second = vi.fn(async () => page([image(99)], null, null, otherId));
    const view = render(<AttachmentsSurface conversationId={conversationId} runtimeGeneration="one" attachments={[]} requestPage={first} />);
    view.rerender(<AttachmentsSurface conversationId={otherId} runtimeGeneration="one" attachments={[]} requestPage={second} />);
    await screen.findByRole("button", { name: "Preview attachment gallery-99.png" });
    await act(async () => pending.resolve(page([image(0)])));
    expect(screen.queryByRole("button", { name: "Preview attachment gallery-0.png" })).toBeNull();
    view.rerender(<AttachmentsSurface conversationId={otherId} runtimeGeneration="two" attachments={[]} requestPage={second} />);
    await waitFor(() => expect(second).toHaveBeenCalledTimes(2));
  });

  it("keeps expired pages recoverable through Newest without appending metadata", async () => {
    const requestPage = vi.fn(async (cursor?: string) => {
      if (cursor) throw new Error("This attachment page has expired.");
      return page([image(60)], "expired");
    });
    render(<AttachmentsSurface conversationId={conversationId} attachments={[]} requestPage={requestPage} />);
    await screen.findByRole("button", { name: "Older attachments" });
    fireEvent.click(screen.getByRole("button", { name: "Older attachments" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("expired");
    fireEvent.click(screen.getByRole("button", { name: "Newest attachments" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(requestPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "expired", undefined]);
  });
});
