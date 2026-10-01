import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";

import { SentMessageAttachmentList } from "../../src/renderer/src/components/SentMessageAttachmentList";

const observations: Array<{ change: (visible: boolean) => void; disconnect: () => void }> = [];
const images: HTMLImageElement[] = [];
const attachments = Array.from({ length: 60 }, (_, index) => ({
  id: `image-${index}`, name: `image-${index}.png`, mimeType: "image/png" as const, size: 1024,
}));

beforeEach(() => {
  observations.length = images.length = 0;
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    images.push(image);
    return image;
  });
  vi.stubGlobal("IntersectionObserver", class {
    disconnect = vi.fn();
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      observations.push({
        disconnect: this.disconnect,
        change: (visible) => this.callback([
          { target, isIntersecting: visible } as IntersectionObserverEntry,
        ], this as unknown as IntersectionObserver),
      });
    }
  });
});

afterEach(() => {
  cleanup();
  for (const image of images) fireEvent.error(image);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("loads only visible sent images by default and releases images without removing keyboard targets", () => {
  const view = render(<SentMessageAttachmentList attachments={attachments} />);
  expect(screen.getAllByRole("button")).toHaveLength(60);
  expect(view.container.querySelectorAll("img")).toHaveLength(0);
  expect(observations).toHaveLength(60);

  act(() => { observations[0]!.change(true); observations[1]!.change(true); });
  expect(view.container.querySelectorAll("img")).toHaveLength(2);
  const first = screen.getByRole("button", { name: "Preview attachment image-0.png" });
  fireEvent.load(first.querySelector("img")!);
  expect(first.querySelector("span")).toHaveAttribute("data-thumbnail-state", "ready");

  const last = screen.getByRole("button", { name: "Preview attachment image-59.png" });
  last.focus();
  act(() => {
    observations[0]!.change(false); observations[1]!.change(false);
    observations[59]!.change(true);
  });
  expect(first.querySelector("img")).toBeNull();
  expect(last).toHaveFocus();
  expect(last.querySelector("img")).toHaveAttribute("src", "inertia://bundle/attachment-preview/image-59");
  expect(view.container.querySelectorAll("img")).toHaveLength(1);

  view.unmount();
  for (const observer of observations) expect(observer.disconnect).toHaveBeenCalledOnce();
});

it("keeps two native reads in flight and admits the focused visible image before old queued rows", () => {
  render(<SentMessageAttachmentList attachments={attachments} />);
  act(() => { for (const entry of observations.slice(0, 40)) entry.change(true); });
  expect(document.querySelectorAll(".sent-attachment-thumbnail img")).toHaveLength(2);
  expect(images).toHaveLength(2);
  const last = screen.getByRole("button", { name: "Preview attachment image-59.png" });
  last.focus();
  act(() => {
    for (const entry of observations.slice(0, 40)) entry.change(false);
    for (const entry of observations.slice(40)) entry.change(true);
  });
  expect(images).toHaveLength(4);
  expect(images[0]!).toHaveAttribute("src", "");
  expect(images[1]!).toHaveAttribute("src", "");
  expect(document.querySelectorAll(".sent-attachment-thumbnail img")).toHaveLength(2);
  expect(images[2]).toHaveAttribute("src", "inertia://bundle/attachment-preview/image-40");
  expect(images[3]).toHaveAttribute("src", "inertia://bundle/attachment-preview/image-41");
  fireEvent.load(images[0]!);
  expect(images).toHaveLength(4);
  fireEvent.load(images[2]!);
  expect(images).toHaveLength(5);
  expect(images[4]).toHaveAttribute("src", "inertia://bundle/attachment-preview/image-59");
  expect(last.querySelector("img")).toBe(images[4]);
  fireEvent.error(images[3]!);
  expect(images).toHaveLength(6);
  expect(images[5]).toHaveAttribute("src", "inertia://bundle/attachment-preview/image-42");
  expect(images.every((image) => !/image-(?:[2-9]|[12]\d|3\d)$/u.test(image.src))).toBe(true);
});

it("abandons an in-flight read when hidden and preserves the next node when React removes the placeholder", () => {
  const view = render(<SentMessageAttachmentList attachments={attachments.slice(0, 1)} />);
  act(() => observations[0]!.change(true));
  const abandoned = images[0]!;
  act(() => observations[0]!.change(false));
  expect(abandoned.isConnected).toBe(false);
  expect(abandoned).toHaveAttribute("src", "");
  act(() => observations[0]!.change(true));
  expect(images).toHaveLength(2);
  const image = images[1]!;
  expect(view.container.querySelector("img")).toBe(image);
  fireEvent.load(abandoned);
  expect(image.parentElement).toHaveAttribute("data-thumbnail-state", "loading");
  fireEvent.load(image);
  expect(view.container.querySelector("img")).toBe(image);
  expect(image.parentElement).toHaveAttribute("data-thumbnail-state", "ready");
  expect(image.parentElement!.querySelector("svg")).toBeNull();
  act(() => observations[0]!.change(false));
  expect(view.container.querySelector("img")).toBeNull();
  act(() => observations[0]!.change(true));
  expect(images).toHaveLength(3);
  expect(images[2]!.parentElement).toHaveAttribute("data-thumbnail-state", "loading");
});

it("shares admission across lists and frees an unmounted list's slots without reviving removed consumers", () => {
  vi.useFakeTimers();
  const first = render(<SentMessageAttachmentList attachments={attachments.slice(0, 3)} />);
  const second = render(<SentMessageAttachmentList attachments={attachments.slice(3, 6)} />);
  act(() => { for (const entry of observations) entry.change(true); });
  expect(images).toHaveLength(2);
  first.unmount();
  expect(images).toHaveLength(2);
  act(() => { vi.runOnlyPendingTimers(); });
  expect(images).toHaveLength(4);
  act(() => { for (const entry of observations.slice(0, 3)) entry.change(true); });
  expect(images).toHaveLength(4);
  expect(images[2]).toHaveAttribute("src", "inertia://bundle/attachment-preview/image-3");
  expect(images[3]).toHaveAttribute("src", "inertia://bundle/attachment-preview/image-4");
  expect(second.container.querySelector("img")).toBe(images[2]);
  fireEvent.load(images[0]!);
  fireEvent.error(images[1]!);
  expect(second.container.querySelector('[data-thumbnail-state="ready"]')).toBeNull();
  expect(second.container.querySelector('[data-attachment-unavailable="true"]')).toBeNull();
});

it("ignores an old source's completion after its replacement is admitted", () => {
  const view = render(<SentMessageAttachmentList attachments={attachments.slice(0, 1)} />);
  act(() => observations[0]!.change(true));
  const oldImage = images[0]!;
  view.rerender(<SentMessageAttachmentList attachments={attachments.slice(1, 2)} />);
  act(() => observations[1]!.change(true));
  const currentImage = images[1]!;
  expect(currentImage).toHaveAttribute("src", "inertia://bundle/attachment-preview/image-1");
  fireEvent.error(oldImage);
  expect(view.container.querySelector("img")).toBe(currentImage);
  expect(view.container.querySelector('[data-attachment-unavailable="true"]')).toBeNull();
  expect(currentImage.parentElement).toHaveAttribute("data-thumbnail-state", "loading");
  fireEvent.load(currentImage);
  expect(currentImage.parentElement).toHaveAttribute("data-thumbnail-state", "ready");
  expect(view.container.querySelector("img")).toBe(currentImage);
});

it("ignores the StrictMode ref replay's abandoned native read", () => {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    disconnect(): void {}
  });
  const view = render(<StrictMode><SentMessageAttachmentList attachments={attachments.slice(0, 1)} /></StrictMode>);
  expect(images).toHaveLength(2);
  expect(images[0]!.isConnected).toBe(false);
  expect(images[0]!).toHaveAttribute("src", "");
  expect(view.container.querySelector("img")).toBe(images[1]);
  fireEvent.load(images[0]!);
  expect(images[1]!.parentElement).toHaveAttribute("data-thumbnail-state", "loading");
  fireEvent.load(images[1]!);
  expect(images[1]!.parentElement).toHaveAttribute("data-thumbnail-state", "ready");
  expect(view.container.querySelector("img")).toBe(images[1]);
});
