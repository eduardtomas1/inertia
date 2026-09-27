import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewPanel } from "../../src/renderer/src/components/PreviewPanel";
import { useDesktopTools } from "../../src/renderer/src/hooks/useDesktopTools";

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

  it("delivers mounted bounds to the lease of every chat the pane shows", async () => {
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
    const previewSetBounds = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        previewConnect: vi.fn(async () => ({
          url: "", loading: false, canGoBack: false, canGoForward: false,
          activeTabId: null, tabs: [], agentActivity: null,
          evidence: { revision: 0, entries: [], omitted: false },
        })),
        previewClose: vi.fn(async () => undefined),
        previewSetBounds,
        onPreviewState: vi.fn(() => () => undefined),
      },
    });
    function Harness({ contextId }: { contextId: string }): React.JSX.Element {
      const tools = useDesktopTools({
        setActionError: vi.fn(),
        previewOwnerId: "primary",
        previewContextId: contextId,
      });
      return (
        <PreviewPanel
          owner="primary"
          contextId={contextId}
          url={tools.previewUrl}
          onNavigate={vi.fn()}
          onOpenExternal={vi.fn()}
          onBoundsChange={tools.setPreviewBounds}
        />
      );
    }
    const bounds = { x: 20, y: 30, width: 640, height: 420 };
    const view = render(<Harness contextId="chat-a" />);

    await waitFor(() => expect(previewSetBounds).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: "chat-a", bounds }),
    ));

    view.rerender(<Harness contextId="chat-b" />);

    await waitFor(() => expect(previewSetBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextId: "chat-b", bounds }),
    ));
  });
});
