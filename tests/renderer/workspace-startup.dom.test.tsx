import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useWorkspaceLayout,
} from "../../src/renderer/src/hooks/useWorkspaceLayout";
import type { WorkspaceStartupSurface } from "../../src/shared/contracts";

class TestResizeObserver implements ResizeObserver {
  readonly root = null;
  readonly thresholds = [];
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

function LayoutHarness({ surface, workspaceId = "conversation-1", forceStackedTools = false }: {
  surface: WorkspaceStartupSurface;
  workspaceId?: string;
  forceStackedTools?: boolean;
}): React.JSX.Element {
  const layout = useWorkspaceLayout("workspace", true, {
    startupSurface: surface,
    startupReady: true,
    workspaceId,
    forceStackedTools,
  });
  return (
    <>
      <output aria-label="Active tool">{layout.activeTool ?? "none"}</output>
      <output aria-label="Stacked tools">{String(layout.stackedTools)}</output>
      <output aria-label="Tool width">{layout.tools.width}</output>
      <button type="button" onClick={layout.toggleWorkspaceTools}>Toggle tools</button>
      <button type="button" onClick={() => layout.showStartupSurface("summary")}>Prefer summary</button>
      <button type="button" onClick={() => layout.showStartupSurface("tools")}>Prefer tools</button>
      <button type="button" onClick={() => layout.setActiveTool("changes")}>Show changes</button>
      <button
        type="button"
        onClick={() => {
          layout.tools.onWidthChange(360);
          layout.tools.onWidthCommit(360);
        }}
      >
        Resize to 360
      </button>
      <button
        type="button"
        onClick={() => {
          layout.tools.onWidthChange(610);
          layout.tools.onWidthCommit(610);
        }}
      >
        Resize to 610
      </button>
    </>
  );
}

describe("workspace startup surface", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return values.size;
        },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      } satisfies Storage,
    });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1600,
    });
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("uses Environment as the stock workspace panel and preserves close/reopen state", async () => {
    render(<LayoutHarness surface="summary" />);
    await waitFor(() =>
      expect(screen.getByLabelText("Active tool")).toHaveTextContent("environment"));

    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("environment");
  });

  it("can start with the last tool and force split-view tools to the bottom", async () => {
    window.localStorage.setItem(
      "inertia:layout:last-workspace-tool:v2",
      "changes",
    );
    render(<LayoutHarness surface="tools" forceStackedTools />);
    await waitFor(() =>
      expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes"));
    expect(screen.getByLabelText("Stacked tools")).toHaveTextContent("true");
  });

  it("keeps Environment narrow without overwriting the other tool width", async () => {
    render(<LayoutHarness surface="summary" />);
    await waitFor(() =>
      expect(screen.getByLabelText("Active tool")).toHaveTextContent("environment"));
    expect(screen.getByLabelText("Tool width")).toHaveTextContent("320");

    fireEvent.click(screen.getByRole("button", { name: "Resize to 360" }));
    expect(screen.getByLabelText("Tool width")).toHaveTextContent("360");
    expect(window.localStorage.getItem("inertia:layout:environment-width:v1"))
      .toBe("360");

    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByLabelText("Tool width")).toHaveTextContent("520");
    fireEvent.click(screen.getByRole("button", { name: "Resize to 610" }));
    expect(window.localStorage.getItem("inertia:layout:workspace-tools-width:v1"))
      .toBe("610");

    fireEvent.click(screen.getByRole("button", { name: "Prefer summary" }));
    expect(screen.getByLabelText("Tool width")).toHaveTextContent("360");
  });

  it("keeps open and selected panel state scoped to each task", async () => {
    const view = render(
      <LayoutHarness surface="summary" workspaceId="conversation-a" />,
    );
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("environment");
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes");

    view.rerender(
      <LayoutHarness surface="summary" workspaceId="conversation-b" />,
    );
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("environment");
    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");

    view.rerender(
      <LayoutHarness surface="summary" workspaceId="conversation-a" />,
    );
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes");
    view.rerender(
      <LayoutHarness surface="summary" workspaceId="conversation-b" />,
    );
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");
  });
});
