import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { PdfAttachmentPreview } from "../../src/renderer/src/components/PdfAttachmentPreview";
import { emulateDisabledFocusFixup } from "./support/focus-fixup";

it("keeps focus on a PDF page button when it reaches the first or last page", async () => {
  const stop = emulateDisabledFocusFixup();
  try {
    const document = { numPages: 2, getPage: vi.fn(() => new Promise(() => undefined)) };
    const getDocument = vi.fn(() => ({ promise: Promise.resolve(document), destroy: vi.fn(async () => undefined) }));
    const loadAttachment = vi.fn(async () => ({ bytes: new Uint8Array(), getDocument }));
    await act(async () => {
      render(<PdfAttachmentPreview source="blob:report" title="report.pdf" onFailure={vi.fn()}
        loadAttachment={loadAttachment as never} prepareCanvas={vi.fn() as never} />);
    });
    const previous = screen.getByRole("button", { name: "Previous PDF page" });
    const next = screen.getByRole("button", { name: "Next PDF page" });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(previous).toHaveAttribute("aria-disabled", "true");

    next.focus();
    await act(async () => { fireEvent.click(next); });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    await act(async () => { fireEvent.click(next); });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  } finally {
    stop();
  }
});

it("serializes pdf.js canvas renders across rapid page changes and fails cleanly on empty documents", async () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  class InstantResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe(target: Element): void {
      Object.defineProperty(target, "clientWidth", { configurable: true, value: 600 });
      this.callback([], this as unknown as ResizeObserver);
    }
    unobserve(): void { /* noop */ }
    disconnect(): void { /* noop */ }
  }
  globalThis.ResizeObserver = InstantResizeObserver as unknown as typeof ResizeObserver;
  try {
    let activeRenders = 0;
    let maxConcurrentRenders = 0;
    let resolveFirstCancel!: () => void;
    let firstRenderCancelled = false;
    const renderPage = vi.fn(() => {
      activeRenders += 1;
      maxConcurrentRenders = Math.max(maxConcurrentRenders, activeRenders);
      if (renderPage.mock.calls.length === 1) {
        const promise = new Promise<void>((_, reject) => {
          resolveFirstCancel = () => {
            activeRenders -= 1;
            const error = new Error("cancelled");
            error.name = "RenderingCancelledException";
            reject(error);
          };
        });
        return {
          promise,
          cancel: () => {
            if (!firstRenderCancelled) {
              firstRenderCancelled = true;
              queueMicrotask(resolveFirstCancel);
            }
          },
        };
      }
      return {
        promise: Promise.resolve().then(() => { activeRenders -= 1; }),
        cancel: vi.fn(),
      };
    });
    const document = {
      numPages: 2,
      getPage: vi.fn(async () => ({ render: renderPage })),
    };
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve(document),
      destroy: vi.fn(async () => undefined),
    }));
    const onFailure = vi.fn();
    await act(async () => {
      render(
        <PdfAttachmentPreview
          source="blob:rapid"
          title="rapid.pdf"
          onFailure={onFailure}
          loadAttachment={vi.fn(async () => ({ bytes: new Uint8Array([1]), getDocument })) as never}
          prepareCanvas={vi.fn(() => ({ context: {} as CanvasRenderingContext2D, viewport: {} as never }))}
        />,
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next PDF page" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(maxConcurrentRenders).toBe(1);
    expect(onFailure).not.toHaveBeenCalled();

    const emptyFailure = vi.fn();
    const emptyDoc = { numPages: 0, getPage: vi.fn() };
    const getEmptyDoc = vi.fn(() => ({
      promise: Promise.resolve(emptyDoc),
      destroy: vi.fn(async () => undefined),
    }));
    await act(async () => {
      render(
        <PdfAttachmentPreview
          source="blob:empty"
          title="empty.pdf"
          onFailure={emptyFailure}
          loadAttachment={vi.fn(async () => ({ bytes: new Uint8Array([1]), getDocument: getEmptyDoc })) as never}
          prepareCanvas={vi.fn() as never}
        />,
      );
    });
    expect(emptyFailure).toHaveBeenCalledOnce();
  } finally {
    globalThis.ResizeObserver = originalResizeObserver;
  }
});
