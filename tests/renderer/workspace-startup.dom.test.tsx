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

function LayoutHarness({ surface, forceStackedTools = false }: {
  surface: WorkspaceStartupSurface;
  forceStackedTools?: boolean;
}): React.JSX.Element {
  const layout = useWorkspaceLayout("workspace", true, {
    startupSurface: surface,
    startupReady: true,
    forceStackedTools,
  });
  return (
    <>
      <output aria-label="Environment open">{String(layout.environmentOpen)}</output>
      <output aria-label="Active tool">{layout.activeTool ?? "none"}</output>
      <output aria-label="Stacked tools">{String(layout.stackedTools)}</output>
      <button type="button" onClick={layout.toggleWorkspaceTools}>Toggle tools</button>
      <button type="button" onClick={() => layout.setEnvironmentOpen(true)}>Show summary</button>
      <button type="button" onClick={() => layout.showStartupSurface("summary")}>Prefer summary</button>
      <button type="button" onClick={() => layout.showStartupSurface("tools")}>Prefer tools</button>
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

  it("uses the compact summary as the stock surface and opens tools on demand", async () => {
    render(<LayoutHarness surface="summary" />);
    await waitFor(() =>
      expect(screen.getByLabelText("Environment open")).toHaveTextContent("true"));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    expect(screen.getByLabelText("Environment open")).toHaveTextContent("false");
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("terminal");

    fireEvent.click(screen.getByRole("button", { name: "Show summary" }));
    expect(screen.getByLabelText("Environment open")).toHaveTextContent("true");
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");
  });

  it("can start with the last tool and force split-view tools to the bottom", async () => {
    window.localStorage.setItem(
      "inertia:layout:last-workspace-tool:v2",
      "changes",
    );
    render(<LayoutHarness surface="tools" forceStackedTools />);
    await waitFor(() =>
      expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes"));
    expect(screen.getByLabelText("Environment open")).toHaveTextContent("false");
    expect(screen.getByLabelText("Stacked tools")).toHaveTextContent("true");
  });
});
