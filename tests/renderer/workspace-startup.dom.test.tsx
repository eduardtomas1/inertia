import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useWorkspaceLayout,
} from "../../src/renderer/src/hooks/useWorkspaceLayout";
import type { WorkspaceStartupSurface } from "../../src/shared/contracts";

const resizeObservers: TestResizeObserver[] = [];

class TestResizeObserver implements ResizeObserver {
  readonly root = null;
  readonly thresholds = [];
  readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  disconnect(): void {
    this.targets.clear();
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }

  emit(target: Element, width: number, height: number): void {
    this.callback([{
      target,
      contentRect: { width, height } as DOMRectReadOnly,
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    }], this);
  }
}

function LayoutHarness({
  surface,
  workspaceId = "conversation-1",
  forceStackedTools = false,
  mountTargets = true,
}: {
  surface: WorkspaceStartupSurface;
  workspaceId?: string;
  forceStackedTools?: boolean;
  mountTargets?: boolean;
}): React.JSX.Element {
  const layout = useWorkspaceLayout("workspace", true, {
    startupSurface: surface,
    startupReady: true,
    workspaceId,
    forceStackedTools,
  });
  return (
    <>
      {mountTargets && (
        <div ref={layout.appShellRef} data-testid="app-shell-target">
          <div
            ref={layout.workspaceBodyRef}
            data-testid="workspace-body-target"
          />
        </div>
      )}
      <output aria-label="Active tool">{layout.activeTool ?? "none"}</output>
      <output aria-label="Stacked tools">{String(layout.stackedTools)}</output>
      <output aria-label="Tool width">{layout.tools.width}</output>
      <output aria-label="Sidebar maximum">{layout.sidebar.max}</output>
      <output aria-label="Tool maximum">{layout.tools.maxWidth}</output>
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
    resizeObservers.length = 0;
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

  it("starts observing layout targets that mount after the hook's initial effect", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    const view = render(
      <LayoutHarness surface="summary" mountTargets={false} />,
    );
    expect(resizeObservers).toHaveLength(0);
    expect(screen.getByLabelText("Sidebar maximum")).toHaveTextContent("352");
    expect(screen.getByLabelText("Tool maximum")).toHaveTextContent("377");

    view.rerender(<LayoutHarness surface="summary" mountTargets />);
    const shell = screen.getByTestId("app-shell-target");
    const body = screen.getByTestId("workspace-body-target");
    await waitFor(() => {
      expect(resizeObservers.some(({ targets }) => targets.has(shell))).toBe(true);
      expect(resizeObservers.some(({ targets }) => targets.has(body))).toBe(true);
    });

    const shellObserver = resizeObservers.find(({ targets }) =>
      targets.has(shell));
    const bodyObserver = resizeObservers.find(({ targets }) =>
      targets.has(body));
    expect(shellObserver).toBeDefined();
    expect(bodyObserver).toBeDefined();
    act(() => {
      shellObserver?.emit(shell, 1440, 900);
      bodyObserver?.emit(body, 1100, 800);
    });

    expect(screen.getByLabelText("Sidebar maximum")).toHaveTextContent("420");
    expect(screen.getByLabelText("Tool maximum")).toHaveTextContent("753");
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
