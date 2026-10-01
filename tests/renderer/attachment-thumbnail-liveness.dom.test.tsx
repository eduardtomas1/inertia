import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SentMessageAttachmentList } from "../../src/renderer/src/components/SentMessageAttachmentList";

const observations = new Map<Element, (visible: boolean) => void>();
const created: HTMLImageElement[] = [];
const attachments = Array.from({ length: 8 }, (_, index) => ({
  id: `image-${index}`, name: `image-${index}.png`, mimeType: "image/png" as const, size: 1024,
}));

function tile(container: HTMLElement, index: number): Element {
  return container.querySelectorAll(".sent-attachment-thumbnail")[index]!;
}

function setVisible(container: HTMLElement, index: number, visible: boolean): void {
  observations.get(tile(container, index))?.(visible);
}

function readIssued(index: number): boolean {
  return document.querySelector(`img[src="inertia://bundle/attachment-preview/image-${index}"]`) !== null;
}

beforeEach(() => {
  observations.clear();
  created.length = 0;
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    created.push(image);
    return image;
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      observations.set(target, (visible) => this.callback([
        { target, isIntersecting: visible } as IntersectionObserverEntry,
      ], this as unknown as IntersectionObserver));
    }
    disconnect(): void {}
  });
});

afterEach(() => {
  cleanup();
  for (const image of created) fireEvent.error(image);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("admits newly visible tiles within 15 seconds when two hidden reads never settle", () => {
  vi.useFakeTimers();
  const view = render(<SentMessageAttachmentList attachments={attachments} />);
  act(() => { setVisible(view.container, 0, true); setVisible(view.container, 1, true); });
  expect(readIssued(0)).toBe(true);
  expect(readIssued(1)).toBe(true);
  act(() => {
    setVisible(view.container, 0, false);
    setVisible(view.container, 1, false);
    setVisible(view.container, 2, true);
    setVisible(view.container, 3, true);
  });
  expect([2, 3].filter(readIssued)).toEqual([]);
  act(() => { vi.advanceTimersByTime(15_000); });
  expect([2, 3].filter(readIssued)).toEqual([2, 3]);
  expect(created[0]).toHaveAttribute("src", "");
  expect(created[1]).toHaveAttribute("src", "");
});

it("shows an image or a placeholder when a loaded tile re-enters the viewport behind busy slots", () => {
  const view = render(<SentMessageAttachmentList attachments={attachments.slice(0, 3)} />);
  act(() => setVisible(view.container, 0, true));
  fireEvent.load(view.container.querySelector("img")!);
  expect(tile(view.container, 0)).toHaveAttribute("data-thumbnail-state", "ready");
  act(() => {
    setVisible(view.container, 0, false);
    setVisible(view.container, 1, true);
    setVisible(view.container, 2, true);
  });
  act(() => setVisible(view.container, 0, true));
  const reentered = tile(view.container, 0);
  expect(reentered.querySelector("img") !== null || reentered.querySelector("svg") !== null).toBe(true);
});

it("loads another conversation's thumbnails within 15 seconds after the previous list unmounts with two hung reads", () => {
  vi.useFakeTimers();
  const first = render(<SentMessageAttachmentList attachments={attachments.slice(0, 2)} />);
  act(() => { setVisible(first.container, 0, true); setVisible(first.container, 1, true); });
  first.unmount();
  const second = render(<SentMessageAttachmentList attachments={attachments.slice(4, 6)} />);
  act(() => { setVisible(second.container, 0, true); setVisible(second.container, 1, true); });
  expect([4, 5].filter(readIssued)).toEqual([]);
  act(() => { vi.advanceTimersByTime(15_000); });
  expect([4, 5].filter(readIssued)).toEqual([4, 5]);
});

it("frees a slot after a visible read stalls for 15 seconds and keeps the tile retryable", () => {
  vi.useFakeTimers();
  const view = render(<SentMessageAttachmentList attachments={attachments.slice(0, 3)} />);
  act(() => {
    setVisible(view.container, 0, true);
    setVisible(view.container, 1, true);
    setVisible(view.container, 2, true);
  });
  expect(readIssued(2)).toBe(false);
  act(() => { vi.advanceTimersByTime(14_999); });
  expect(readIssued(2)).toBe(false);
  act(() => { vi.advanceTimersByTime(1); });
  expect(readIssued(2)).toBe(true);
  expect(readIssued(0)).toBe(false);
  expect(tile(view.container, 0)).toHaveAttribute("data-thumbnail-state", "loading");
  expect(tile(view.container, 0).querySelector("svg")).not.toBeNull();
  fireEvent.load(created[0]!);
  expect(tile(view.container, 0)).toHaveAttribute("data-thumbnail-state", "loading");
  act(() => { setVisible(view.container, 0, false); setVisible(view.container, 0, true); });
  expect(readIssued(0)).toBe(true);
});

it("retries a stalled read while its tile stays visible, with backoff and a bounded number of attempts", () => {
  vi.useFakeTimers();
  const view = render(<SentMessageAttachmentList attachments={attachments.slice(0, 1)} />);
  const reads = () => created.filter((image) => image.getAttribute("src") === "inertia://bundle/attachment-preview/image-0").length;
  act(() => setVisible(view.container, 0, true));
  expect(reads()).toBe(1);
  act(() => { vi.advanceTimersByTime(15_000); });
  expect(reads()).toBe(0);
  act(() => { vi.advanceTimersByTime(1_000); });
  expect(reads()).toBe(1);
  act(() => { vi.advanceTimersByTime(15_000); });
  act(() => { vi.advanceTimersByTime(2_000); });
  expect(reads()).toBe(1);
  fireEvent.load(created.at(-1)!);
  expect(tile(view.container, 0)).toHaveAttribute("data-thumbnail-state", "ready");
  expect(created).toHaveLength(3);
});

it("stops retrying a visible tile after three stalled reads until it becomes visible again", () => {
  vi.useFakeTimers();
  const view = render(<SentMessageAttachmentList attachments={attachments.slice(0, 1)} />);
  act(() => setVisible(view.container, 0, true));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    act(() => { vi.advanceTimersByTime(20_000); });
  }
  expect(created).toHaveLength(3);
  expect(tile(view.container, 0)).toHaveAttribute("data-thumbnail-state", "loading");
  act(() => { setVisible(view.container, 0, false); setVisible(view.container, 0, true); });
  expect(created).toHaveLength(4);
});

it("admits waiting tiles in document order whatever order their visibility callbacks arrive in", () => {
  const view = render(<SentMessageAttachmentList attachments={attachments} />);
  act(() => { setVisible(view.container, 7, true); setVisible(view.container, 6, true); });
  act(() => { for (let index = 5; index >= 0; index -= 1) setVisible(view.container, index, true); });
  expect([0, 1, 2, 3, 4, 5].filter(readIssued)).toEqual([]);
  fireEvent.load(created[0]!);
  expect([0, 1, 2, 3, 4, 5].filter(readIssued)).toEqual([0]);
  fireEvent.load(created[1]!);
  expect([0, 1, 2, 3, 4, 5].filter(readIssued)).toEqual([0, 1]);
});

it("lets never-tried tiles ahead of retried stalled tiles so healthy thumbnails keep main's schedule", () => {
  vi.useFakeTimers();
  const view = render(<SentMessageAttachmentList attachments={attachments} />);
  const startedAt = new Map<HTMLImageElement, number>();
  const firstRead = new Map<number, number>();
  const readyAt = new Map<number, number>();
  act(() => { for (let index = 0; index < 8; index += 1) setVisible(view.container, index, true); });
  for (let now = 0; now <= 60_000; now += 500) {
    for (const image of [...created]) {
      const source = image.getAttribute("src");
      if (!source || !image.onload) continue;
      if (!startedAt.has(image)) startedAt.set(image, now);
      const index = Number(source.at(-1));
      if (!firstRead.has(index)) firstRead.set(index, now);
      if (index >= 2 && now - startedAt.get(image)! >= 3_000) {
        fireEvent.load(image);
        readyAt.set(index, now);
      }
    }
    act(() => { vi.advanceTimersByTime(500); });
  }
  expect([...readyAt.keys()].sort()).toEqual([2, 3, 4, 5, 6, 7]);
  expect(Math.max(firstRead.get(4)!, firstRead.get(5)!)).toBeLessThanOrEqual(18_500);
  expect(Math.max(firstRead.get(6)!, firstRead.get(7)!)).toBeLessThanOrEqual(22_000);
});
