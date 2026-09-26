import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  transferDraftWorkspacePanel,
  useWorkspaceLayout,
} from "../../src/renderer/src/hooks/useWorkspaceLayout";

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
  workspaceId = "conversation-1",
  forceStackedTools = false,
  mountTargets = true,
}: {
  workspaceId?: string;
  forceStackedTools?: boolean;
  mountTargets?: boolean;
}): React.JSX.Element {
  const layout = useWorkspaceLayout("workspace", true, {
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
      <output aria-label="Panel open">{String(layout.panel.isOpen)}</output>
      <output aria-label="Surfaces">{layout.panel.surfaces.join(",")}</output>
      <output aria-label="Panel presentation">{layout.panelPresentation}</output>
      <output aria-label="Stacked tools">{String(layout.stackedTools)}</output>
      <output aria-label="Tool width">{layout.tools.width}</output>
      <output aria-label="Sidebar maximum">{layout.sidebar.max}</output>
      <output aria-label="Tool maximum">{layout.tools.maxWidth}</output>
      <button type="button" onClick={layout.toggleWorkspaceTools}>Toggle tools</button>
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

  it("starts with the chat alone and reopens the launcher or the last surface", async () => {
    render(<LayoutHarness />);
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("false");

    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("true");
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");
    expect(screen.getByLabelText("Surfaces")).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes");
    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");
    expect(screen.getByLabelText("Surfaces")).toHaveTextContent("changes");

    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes"));
    expect(window.localStorage.getItem("inertia:layout:workspace-panel:conversation-1:v1"))
      .toBe(JSON.stringify({ isOpen: true, activeSurfaceId: "changes", surfaces: ["changes"] }));
  });

  it.each(["getItem", "setItem"] as const)("keeps workspace controls usable when layout storage fails (%s)", (method) => {
    vi.spyOn(window.localStorage, method).mockImplementation(() => {
      throw new DOMException("Storage unavailable", method === "getItem" ? "SecurityError" : "QuotaExceededError");
    });
    const view = render(<LayoutHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes");
    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("false");
    view.rerender(<LayoutHarness workspaceId="another-chat" />);
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes");
  });

  it("starts observing layout targets that mount after the hook's initial effect", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    const view = render(
      <LayoutHarness mountTargets={false} />,
    );
    expect(resizeObservers).toHaveLength(0);
    expect(screen.getByLabelText("Sidebar maximum")).toHaveTextContent("420");
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByLabelText("Sidebar maximum")).toHaveTextContent("332");
    expect(screen.getByLabelText("Tool maximum")).toHaveTextContent("357");

    view.rerender(<LayoutHarness mountTargets />);
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
    expect(screen.getByLabelText("Tool maximum")).toHaveTextContent("733");
  });

  it("ignores the global last tool for a new chat, including stacked layouts", () => {
    window.localStorage.setItem(
      "inertia:layout:last-workspace-tool:v2",
      "changes",
    );
    render(<LayoutHarness forceStackedTools />);
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("false");
    expect(screen.getByLabelText("Stacked tools")).toHaveTextContent("true");
  });

  it("keeps one persisted panel width across surfaces", () => {
    render(<LayoutHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByLabelText("Tool width")).toHaveTextContent("520");

    fireEvent.click(screen.getByRole("button", { name: "Resize to 360" }));
    expect(screen.getByLabelText("Tool width")).toHaveTextContent("360");
    expect(window.localStorage.getItem("inertia:layout:workspace-tools-width:v1"))
      .toBe("360");

    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes");
    expect(screen.getByLabelText("Tool width")).toHaveTextContent("360");
  });

  it("overlays the panel as a sheet when the chat would drop below 360px", async () => {
    render(<LayoutHarness />);
    const body = screen.getByTestId("workspace-body-target");
    await waitFor(() =>
      expect(resizeObservers.some(({ targets }) => targets.has(body))).toBe(true));
    const bodyObserver = resizeObservers.find(({ targets }) => targets.has(body))!;

    act(() => bodyObserver.emit(body, 667, 800));
    expect(screen.getByLabelText("Panel presentation")).toHaveTextContent("inline");

    act(() => bodyObserver.emit(body, 666, 800));
    expect(screen.getByLabelText("Panel presentation")).toHaveTextContent("sheet");

    act(() => bodyObserver.emit(body, 1100, 800));
    expect(screen.getByLabelText("Panel presentation")).toHaveTextContent("inline");
  });

  it("returns to the inline panel once the sidebar can yield instead of staying a sheet", async () => {
    // A wide persisted sidebar: in sheet mode it keeps 420px, which leaves the
    // body under the inline threshold even though the inline layout would
    // clamp the sidebar to 308px at a 1000px shell and fit the panel.
    window.localStorage.setItem("inertia:layout:sidebar-width:v1", "420");
    render(<LayoutHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("true");
    const shell = screen.getByTestId("app-shell-target");
    const body = screen.getByTestId("workspace-body-target");
    await waitFor(() =>
      expect(resizeObservers.some(({ targets }) => targets.has(body))).toBe(true));
    const shellObserver = resizeObservers.find(({ targets }) => targets.has(shell))!;
    const bodyObserver = resizeObservers.find(({ targets }) => targets.has(body))!;

    // Narrow window: the sidebar wins, the panel becomes a sheet.
    act(() => shellObserver.emit(shell, 890, 800));
    act(() => bodyObserver.emit(body, 445, 800));
    expect(screen.getByLabelText("Panel presentation")).toHaveTextContent("sheet");
    expect(screen.getByLabelText("Sidebar maximum")).toHaveTextContent("420");

    // The window grows to 1000px while the sheet still holds the 420px sidebar,
    // so the measured body is only 573px. The inline layout would give 685px.
    act(() => shellObserver.emit(shell, 1000, 800));
    act(() => bodyObserver.emit(body, 573, 800));
    expect(screen.getByLabelText("Panel presentation")).toHaveTextContent("inline");
    expect(screen.getByLabelText("Sidebar maximum")).toHaveTextContent("308");

    // And the decision holds once the body is measured with the yielded sidebar.
    act(() => bodyObserver.emit(body, 685, 800));
    expect(screen.getByLabelText("Panel presentation")).toHaveTextContent("inline");
  });

  it("keeps open and selected panel state scoped to each task", () => {
    const view = render(
      <LayoutHarness workspaceId="conversation-a" />,
    );
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes");

    view.rerender(
      <LayoutHarness workspaceId="conversation-b" />,
    );
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("true");

    view.rerender(
      <LayoutHarness workspaceId="conversation-a" />,
    );
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes");
    view.rerender(
      <LayoutHarness workspaceId="conversation-b" />,
    );
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("none");
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    view.rerender(<LayoutHarness workspaceId="conversation-a" />);
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("changes");
    view.rerender(<LayoutHarness workspaceId="conversation-b" />);
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("false");
    view.unmount();
    render(<LayoutHarness workspaceId="conversation-b" />);
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("false");
  });

  it.each([true, false])("carries an explicit draft panel into its saved chat (open: %s)", (isOpen) => {
    const panel = { isOpen, activeSurfaceId: "usage", surfaces: ["agents", "usage"] };
    const source = "inertia:layout:workspace-panel:project%3Adraft:v1";
    window.localStorage.setItem(source, JSON.stringify(panel));
    transferDraftWorkspacePanel("project", "draft", "saved");
    expect(window.localStorage.getItem(source)).toBeNull();
    const view = render(<LayoutHarness workspaceId="project:saved" />);
    expect(screen.getByLabelText("Panel open")).toHaveTextContent(String(isOpen));
    expect(screen.getByLabelText("Surfaces")).toHaveTextContent("agents,usage");
    if (!isOpen) fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
    expect(screen.getByLabelText("Active tool")).toHaveTextContent("usage");
    view.rerender(<LayoutHarness workspaceId="project:unrelated" />);
    expect(screen.getByLabelText("Panel open")).toHaveTextContent("false");
  });

  it("does not replace an existing destination panel or copy global tool preferences", () => {
    window.localStorage.setItem("inertia:layout:last-workspace-tool:v2", "changes");
    transferDraftWorkspacePanel("project", "draft", "empty");
    expect(window.localStorage.getItem("inertia:layout:workspace-panel:project%3Aempty:v1")).toBeNull();
    const saved = JSON.stringify({ isOpen: false, activeSurfaceId: "files", surfaces: ["files"] });
    const target = "inertia:layout:workspace-panel:project%3Asaved:v1";
    window.localStorage.setItem(target, saved);
    window.localStorage.setItem("inertia:layout:workspace-panel:project%3Adraft:v1",
      JSON.stringify({ isOpen: true, activeSurfaceId: "agents", surfaces: ["agents"] }));
    transferDraftWorkspacePanel("project", "draft", "saved");
    expect(window.localStorage.getItem(target)).toBe(saved);
  });
  it.each(["getItem", "setItem", "removeItem"] as const)("keeps chat creation independent of failing panel storage (%s)", (method) => {
    window.localStorage.setItem("inertia:layout:workspace-panel:project%3Adraft:v1",
      JSON.stringify({ isOpen: true, activeSurfaceId: "usage", surfaces: ["usage"] }));
    vi.spyOn(window.localStorage, method).mockImplementation(() => { throw new Error("Storage unavailable"); });
    expect(() => transferDraftWorkspacePanel("project", "draft", "saved")).not.toThrow();
  });

});
