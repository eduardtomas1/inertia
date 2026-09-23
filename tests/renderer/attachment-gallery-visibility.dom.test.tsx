import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SentMessageAttachmentList } from "../../src/renderer/src/components/SentMessageAttachmentList";

afterEach(() => vi.unstubAllGlobals());

it("loads only visible gallery images and releases images without removing keyboard targets", () => {
  const observations: Array<{ change: (visible: boolean) => void; disconnect: () => void }> = [];
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
  const attachments = Array.from({ length: 60 }, (_, index) => ({
    id: `image-${index}`, name: `image-${index}.png`, mimeType: "image/png" as const, size: 1024,
  }));
  const view = render(<SentMessageAttachmentList attachments={attachments} deferImages />);
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
