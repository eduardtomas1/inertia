import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PreviewPanel } from "../../src/renderer/src/components/PreviewPanel";
import type {
  BrowserEvidenceSnapshot,
} from "../../src/shared/browser-evidence";

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

const evidence: BrowserEvidenceSnapshot = {
  revision: 4,
  omitted: true,
  entries: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      sequence: 1,
      kind: "navigation",
      tabId: "tab-one",
      pageNumber: 1,
      documentSequence: 1,
      runId: null,
      turnId: null,
      occurredAt: "2026-08-22T12:00:00.000Z",
      summary: "Navigated",
      detail: "http://127.0.0.1:4173",
      origin: "http://127.0.0.1:4173",
      redacted: true,
      occurrences: 1,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      sequence: 2,
      kind: "console-error",
      tabId: "tab-one",
      pageNumber: 1,
      documentSequence: 1,
      runId: null,
      turnId: null,
      occurredAt: "2026-08-22T12:00:01.000Z",
      summary: "Page console error",
      detail: "<img src=x onerror=alert(1)>",
      origin: "http://127.0.0.1:4173",
      redacted: false,
      occurrences: 2,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      sequence: 3,
      kind: "screenshot",
      tabId: "tab-one",
      pageNumber: 1,
      documentSequence: 1,
      runId: "44444444-4444-4444-8444-444444444444",
      turnId: "55555555-5555-4555-8555-555555555555",
      occurredAt: "2026-08-22T12:00:02.000Z",
      summary: "Agent captured the page",
      detail: null,
      origin: "http://127.0.0.1:4173",
      redacted: false,
      occurrences: 1,
      screenshot: { available: true, width: 320, height: 180 },
    },
  ],
};

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
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
});

describe("Browser evidence timeline", () => {
  it("replaces the native stage, renders hostile evidence as text, and restores focus", async () => {
    const onBoundsChange = vi.fn();
    const loadImage = vi.fn(async () => ({
      mimeType: "image/png" as const,
      data: Buffer.from("bounded-capture").toString("base64"),
    }));
    const view = render(
      <PreviewPanel
        owner="primary"
        contextId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        url="http://127.0.0.1:4173/hidden?access_token=never-render"
        tabs={[{
          id: "tab-one",
          title: "Local app",
          url: "http://127.0.0.1:4173/",
          loading: false,
        }]}
        activeTabId="tab-one"
        evidence={evidence}
        onNavigate={vi.fn()}
        onOpenExternal={vi.fn()}
        onLoadEvidenceImage={loadImage}
        onBoundsChange={onBoundsChange}
      />,
    );

    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
    expect(onBoundsChange).toHaveBeenCalledWith({
      x: 20, y: 30, width: 640, height: 420,
    });

    const toggle = screen.getByRole("button", { name: /Evidence 3/u });
    fireEvent.click(toggle);

    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(onBoundsChange).toHaveBeenLastCalledWith(null);
    expect(await screen.findByText("Local evidence")).toBeInTheDocument();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[aria-live]")).toBeNull();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Browser evidence" }))
      .toHaveFocus();

    fireEvent.click(screen.getByText("Inspect capture"));
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
    ));
    expect(await screen.findByRole("img", { name: /Browser screenshot from Page 1/u }))
      .toHaveAttribute("src", expect.stringMatching(/^data:image\/png;base64,/u));

    fireEvent.keyDown(screen.getByText("Local evidence"), { key: "Escape" });
    await waitFor(() => expect(toggle).toHaveFocus());
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
    expect(onBoundsChange).toHaveBeenLastCalledWith({
      x: 20, y: 30, width: 640, height: 420,
    });

    fireEvent.click(toggle);
    view.rerender(
      <PreviewPanel
        owner="primary"
        contextId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        url="http://127.0.0.1:4173/"
        evidence={{ revision: 0, entries: [], omitted: false }}
        onNavigate={vi.fn()}
        onOpenExternal={vi.fn()}
        onBoundsChange={onBoundsChange}
      />,
    );
    await waitFor(() => expect(screen.queryByText("Local evidence")).not.toBeInTheDocument());
  });

  it("provides roving tab focus and keyboard tab closure", () => {
    const onActivateTab = vi.fn();
    const onCloseTab = vi.fn();
    render(
      <PreviewPanel
        owner="primary"
        url="http://127.0.0.1:4173/"
        tabs={[
          { id: "one", title: "One", url: "http://127.0.0.1:4173/one", loading: false },
          { id: "two", title: "Two", url: "http://127.0.0.1:4173/two", loading: false },
        ]}
        activeTabId="one"
        onNavigate={vi.fn()}
        onOpenExternal={vi.fn()}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
      />,
    );

    const first = screen.getByRole("tab", { name: "One" });
    const second = screen.getByRole("tab", { name: "Two" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onActivateTab).toHaveBeenCalledWith("two");
    expect(second).toHaveFocus();

    fireEvent.keyDown(second, { key: "Delete" });
    expect(onCloseTab).toHaveBeenCalledWith("two");
  });
});
