import { readFileSync } from "node:fs";

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/src/components/lazySurfaceLoaders", () => ({
  prefetchWorkspaceTool: () => undefined,
}));

import { WorkspacePanel, type WorkspacePanelTab } from "../../src/renderer/src/components/WorkspacePanel";
import {
  activateRightPanelSurface,
  CLOSE_ACTIVE_PANEL_SURFACE_EVENT,
  closeRightPanelSurface,
  moveRightPanelSurface,
  openRightPanelSurface,
  type RightPanelState,
} from "../../src/renderer/src/utils/rightPanelSurfaces";

function Host({
  initial,
  onMove,
  unavailable = {},
}: {
  initial: RightPanelState;
  onMove?: (surface: WorkspacePanelTab, toIndex: number) => void;
  unavailable?: Partial<Record<WorkspacePanelTab, string>>;
}): React.JSX.Element {
  const [state, setState] = useState(initial);
  return (
    <>
      <button type="button">Outside</button>
      <WorkspacePanel
        surfaces={state.surfaces}
        activeSurface={state.activeSurfaceId}
        visible={state.isOpen}
        unavailable={unavailable}
        onActivateSurface={(surface) => setState((current) => activateRightPanelSurface(current, surface))}
        onOpenSurface={(surface) => setState((current) => openRightPanelSurface(current, surface))}
        onCloseSurface={(surface) => setState((current) => closeRightPanelSurface(current, surface))}
        onMoveSurface={(surface, toIndex) => {
          onMove?.(surface, toIndex);
          setState((current) => moveRightPanelSurface(current, surface, toIndex));
        }}
      >
        <span>{state.activeSurfaceId} content</span>
      </WorkspacePanel>
    </>
  );
}

const state = (active: WorkspacePanelTab, ...surfaces: WorkspacePanelTab[]): RightPanelState => ({
  isOpen: true,
  surfaces,
  activeSurfaceId: active,
});

const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-workspace-tab"));

function stubTabBoxes(list: HTMLElement, width = 100, listWidth = 1000): void {
  list.getBoundingClientRect = () => new DOMRect(0, 0, listWidth, 32);
  list.querySelectorAll<HTMLElement>(":scope > [data-tab-key]").forEach((tab, index) => {
    tab.getBoundingClientRect = () => new DOMRect(index * width - list.scrollLeft, 0, width, 32);
  });
}

describe("workspace panel tab row", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reorders tabs by pointer drag past a neighbour's midpoint", () => {
    const onMove = vi.fn();
    render(<Host initial={state("changes", "changes", "preview", "terminal")} onMove={onMove} />);
    const list = screen.getByRole("tablist", { name: "Panel surfaces" });
    stubTabBoxes(list);
    const changes = list.querySelector<HTMLElement>('[data-tab-key="changes"]')!;

    fireEvent.pointerDown(changes, { button: 0, pointerId: 1, clientX: 50 });
    fireEvent.pointerMove(list, { pointerId: 1, clientX: 52 });
    expect(list.querySelector(".is-dragging")).toBeNull();
    fireEvent.pointerMove(list, { pointerId: 1, clientX: 210 });
    expect(tabNames()).toEqual(["preview", "changes", "terminal"]);
    fireEvent.pointerMove(list, { pointerId: 1, clientX: 260 });
    expect(tabNames()).toEqual(["preview", "terminal", "changes"]);
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.pointerUp(list, { pointerId: 1, clientX: 260 });

    expect(onMove).toHaveBeenCalledExactlyOnceWith("changes", 2);
    expect(tabNames()).toEqual(["preview", "terminal", "changes"]);
  });

  it("cancels a drag with Escape and keeps the order", () => {
    const onMove = vi.fn();
    render(<Host initial={state("changes", "changes", "preview", "terminal")} onMove={onMove} />);
    const list = screen.getByRole("tablist", { name: "Panel surfaces" });
    stubTabBoxes(list);
    const terminal = list.querySelector<HTMLElement>('[data-tab-key="terminal"]')!;

    fireEvent.pointerDown(terminal, { button: 0, pointerId: 4, clientX: 250 });
    fireEvent.pointerMove(list, { pointerId: 4, clientX: 20 });
    expect(tabNames()).toEqual(["terminal", "changes", "preview"]);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(list, { pointerId: 4, clientX: 20 });

    expect(onMove).not.toHaveBeenCalled();
    expect(tabNames()).toEqual(["changes", "preview", "terminal"]);
  });

  it("moves the focused tab with the primary modifier, Shift and an arrow", () => {
    const onMove = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    render(<Host initial={state("preview", "changes", "preview", "terminal")} onMove={onMove} />);
    const preview = screen.getByRole("tab", { name: "Browser" });
    preview.focus();

    expect(preview.getAttribute("aria-keyshortcuts")?.split(" "))
      .toEqual(expect.arrayContaining(["Delete", "Control+Shift+ArrowLeft", "Meta+Shift+ArrowRight"]));
    fireEvent.keyDown(preview, { key: "ArrowRight", metaKey: true, shiftKey: true });
    expect(onMove).toHaveBeenLastCalledWith("preview", 2);
    expect(screen.getByRole("status")).toHaveTextContent("Browser moved to position 3 of 3");
    expect(tabNames()).toEqual(["changes", "terminal", "preview"]);
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Browser" }), { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    expect(onMove).toHaveBeenLastCalledWith("preview", 1);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Browser" }), { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Browser" }), { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    expect(onMove).toHaveBeenCalledTimes(3);
    expect(tabNames()).toEqual(["preview", "changes", "terminal"]);
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
  });

  it("maps a move among visible tabs onto the stored order around unavailable surfaces", () => {
    const onMove = vi.fn();
    render(
      <Host
        initial={state("changes", "changes", "agents", "preview", "terminal")}
        unavailable={{ agents: "Unavailable" }}
        onMove={onMove}
      />,
    );
    const changes = screen.getByRole("tab", { name: "Changes" });
    fireEvent.keyDown(changes, { key: "ArrowRight", metaKey: true, shiftKey: true });
    expect(onMove).toHaveBeenCalledWith("changes", 2);
    expect(tabNames()).toEqual(["preview", "changes", "terminal"]);
  });

  it("scrolls the active tab into view whenever the active surface changes", () => {
    render(<Host initial={state("changes", "changes", "preview", "terminal", "files", "plan")} />);
    const list = screen.getByRole("tablist", { name: "Panel surfaces" });
    stubTabBoxes(list, 100, 220);
    expect(list.scrollLeft).toBe(0);

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(list.scrollLeft).toBe(304);

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(list.scrollLeft).toBe(0);
  });

  it("scrolls the active tab back into view when the hidden row is shown again", () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    });
    render(<Host initial={state("plan", "changes", "preview", "terminal", "files", "plan")} />);
    const list = screen.getByRole("tablist", { name: "Panel surfaces" });
    stubTabBoxes(list, 100, 220);
    list.scrollLeft = 0;
    act(() => {
      for (const observer of observers) observer();
    });
    expect(list.scrollLeft).toBe(304);
  });

  it("puts a focusable close control over the tab icon and closes with it", () => {
    render(<Host initial={state("preview", "changes", "preview")} />);
    const tab = screen.getByRole("tab", { name: "Browser" }).closest<HTMLElement>(".panel-tab")!;
    const close = within(tab).getByRole("button", { name: "Close Browser" });
    expect(close).toHaveAttribute("tabindex", "0");
    expect(close.closest(".panel-tab")).toBe(tab);
    expect(screen.getByRole("button", { name: "Close Changes" })).toHaveAttribute("tabindex", "-1");
    expect(tab.querySelector('[role="tab"] > svg:first-child')).not.toBeNull();

    fireEvent.click(close);
    expect(tabNames()).toEqual(["changes"]);
  });

  it("closes a tab with the middle button", () => {
    render(<Host initial={state("preview", "changes", "preview")} />);
    const tab = screen.getByRole("tab", { name: "Changes" }).closest<HTMLElement>(".panel-tab")!;
    fireEvent(tab, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(tabNames()).toEqual(["preview"]);
  });

  it("closes the active tab on the panel's close request and keeps focus outside", () => {
    render(<Host initial={state("preview", "changes", "preview", "terminal")} />);
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    const panel = screen.getByRole("complementary", { name: "Workspace tools" });
    let request = new Event(CLOSE_ACTIVE_PANEL_SURFACE_EVENT, { cancelable: true });
    act(() => {
      panel.dispatchEvent(request);
    });
    expect(request.defaultPrevented).toBe(true);
    expect(tabNames()).toEqual(["changes", "terminal"]);
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");
    expect(outside).toHaveFocus();

    for (let index = 0; index < 2; index += 1) {
      act(() => {
        panel.dispatchEvent(new Event(CLOSE_ACTIVE_PANEL_SURFACE_EVENT, { cancelable: true }));
      });
    }
    expect(screen.queryAllByRole("tab")).toEqual([]);
    request = new Event(CLOSE_ACTIVE_PANEL_SURFACE_EVENT, { cancelable: true });
    act(() => {
      panel.dispatchEvent(request);
    });
    expect(request.defaultPrevented).toBe(false);
  });

  it("marks surfaces that are already open in the add menu", async () => {
    render(<Host initial={state("changes", "changes", "preview")} />);
    fireEvent.click(screen.getByRole("button", { name: "Add panel surface" }));
    const menu = await screen.findByRole("menu", { name: "Add panel surface" });
    const browser = await within(menu).findByRole("menuitem", { name: /^Browser/u });
    expect(browser).not.toHaveAttribute("aria-current");
    expect(browser).toHaveAccessibleName(/^Browser\s*, open/u);
    expect(within(menu).getByRole("menuitem", { name: /^Terminal/u })).not.toHaveAccessibleName(/open/u);
  });

  it("swaps the tab icon for the close control on hover or keyboard focus only", () => {
    const css = readFileSync("src/renderer/src/styles.css", "utf8");
    expect(css).toContain(".panel-tab:is(:hover, :has(:focus-visible)) > .panel-tab-close {");
    expect(css).toContain(".panel-tab:is(:hover, :has(:focus-visible)) > [role=\"tab\"] > svg:first-child {");
    expect(css).not.toContain(".panel-tab:is(:hover, :focus-within)");
  });

  it("keeps the add button on the 2px outside button ring", () => {
    const css = readFileSync("src/renderer/src/styles.css", "utf8");
    const inset = /^:is\(\n(?<list>[\s\S]*?)\n\):focus-visible \{\n  outline-offset: -2px;\n\}/mu.exec(css)?.groups?.list ?? "";
    expect(inset).toContain('[role="tab"]');
    expect(inset).not.toContain(".workspace-panel-add");
  });
});
