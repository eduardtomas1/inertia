import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewPanel } from "../../src/renderer/src/components/PreviewPanel";

let notifyResize: (() => void) | undefined;

class TestResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    notifyResize = () => callback([], this);
  }

  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

afterEach(() => {
  notifyResize = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PreviewPanel native bounds", () => {
  it("finishes StrictMode effect replay with visible bounds", () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 30,
      width: 640,
      height: 420,
      top: 30,
      left: 20,
      right: 660,
      bottom: 450,
      toJSON: () => ({}),
    });
    const onBoundsChange = vi.fn();

    render(
      <PreviewPanel
        owner="primary"
        url="http://127.0.0.1:4173/strict"
        onNavigate={vi.fn()}
        onOpenExternal={vi.fn()}
        onBoundsChange={onBoundsChange}
      />,
      { reactStrictMode: true },
    );

    expect(onBoundsChange.mock.calls).toEqual([
      [{ x: 20, y: 30, width: 640, height: 420 }],
      [null],
      [{ x: 20, y: 30, width: 640, height: 420 }],
    ]);
  });

  it("keeps bounds stable across URL-only rerenders", () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 20,
        y: 30,
        width: 640,
        height: 420,
        top: 30,
        left: 20,
        right: 660,
        bottom: 450,
        toJSON: () => ({}),
      });
    const onBoundsChange = vi.fn();
    const panel = (url: string) => (
      <PreviewPanel
        owner="primary"
        url={url}
        onNavigate={vi.fn()}
        onOpenExternal={vi.fn()}
        onBoundsChange={onBoundsChange}
      />
    );
    const view = render(panel("http://127.0.0.1:4173/first"));

    expect(onBoundsChange).toHaveBeenCalledWith({
      x: 20,
      y: 30,
      width: 640,
      height: 420,
    });
    onBoundsChange.mockClear();

    view.rerender(panel("http://127.0.0.1:4173/second"));

    expect(onBoundsChange).not.toHaveBeenCalled();

    bounds.mockReturnValue({
      x: 24,
      y: 36,
      width: 600,
      height: 400,
      top: 36,
      left: 24,
      right: 624,
      bottom: 436,
      toJSON: () => ({}),
    });
    notifyResize?.();
    expect(onBoundsChange).toHaveBeenLastCalledWith({
      x: 24,
      y: 36,
      width: 600,
      height: 400,
    });

    view.unmount();
    expect(onBoundsChange).toHaveBeenLastCalledWith(null);
  });
});
