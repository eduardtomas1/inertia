import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefetchWorkspaceTool = vi.hoisted(() => vi.fn());

vi.mock("../../src/renderer/src/components/lazySurfaceLoaders", () => ({
  prefetchWorkspaceTool,
}));

import {
  WorkspacePanel,
  type WorkspacePanelPresentation,
  type WorkspacePanelTab,
} from "../../src/renderer/src/components/WorkspacePanel";
import {
  activateRightPanelSurface,
  closeRightPanelSurface,
  EMPTY_RIGHT_PANEL_STATE,
  hideRightPanel,
  openRightPanelSurface,
  type RightPanelState,
} from "../../src/renderer/src/utils/rightPanelSurfaces";

function SurfaceHost({
  initial = { isOpen: true, surfaces: [], activeSurfaceId: null },
  presentation = "inline",
  unavailable = {},
  onChange = () => undefined,
}: {
  initial?: RightPanelState;
  presentation?: WorkspacePanelPresentation;
  unavailable?: Partial<Record<WorkspacePanelTab, string>>;
  onChange?: (state: RightPanelState) => void;
}): React.JSX.Element {
  const [state, setState] = useState(initial);
  const update = (next: (current: RightPanelState) => RightPanelState): void => {
    setState((current) => {
      const value = next(current);
      onChange(value);
      return value;
    });
  };
  return (
    <WorkspacePanel
      surfaces={state.surfaces}
      activeSurface={state.activeSurfaceId}
      presentation={presentation}
      visible={state.isOpen}
      unavailable={unavailable}
      liveAgentCount={2}
      onActivateSurface={(surface) => update((current) => activateRightPanelSurface(current, surface))}
      onOpenSurface={(surface) => update((current) => openRightPanelSurface(current, surface))}
      onCloseSurface={(surface) => update((current) => closeRightPanelSurface(current, surface))}
      onClosePanel={() => update(hideRightPanel)}
    >
      <span>{state.activeSurfaceId ?? "launcher"} content</span>
    </WorkspacePanel>
  );
}

function openState(...surfaces: WorkspacePanelTab[]): RightPanelState {
  return {
    isOpen: true,
    surfaces,
    activeSurfaceId: surfaces[0] ?? null,
  };
}

describe("right panel surface host", () => {
  beforeEach(() => {
    prefetchWorkspaceTool.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function pendingPanelOpening() {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
    const panel = (visible: boolean) => <>
      <div data-panel-layout-controls>
        <button>Toggle tools</button>
        <button>Toggle terminal</button>
        <button>Other toolbar control</button>
      </div>
      <WorkspacePanel
        surfaces={[]}
        activeSurface={null}
        visible={visible}
        onActivateSurface={() => undefined}
        onOpenSurface={() => undefined}
        onCloseSurface={() => undefined}
        onClosePanel={() => undefined}
      >
        {null}
      </WorkspacePanel>
    </>;
    const view = render(panel(false));
    await waitFor(() => expect(view.container.querySelector(".workspace-panel-launcher"))
      .toHaveAttribute("tabindex", "0"));
    const opener = screen.getByRole("button", { name: "Toggle tools" });
    opener.focus();
    view.rerender(panel(true));
    expect(frames.size).toBeGreaterThan(0);
    return {
      opener,
      frames,
      close: () => view.rerender(panel(false)),
      unmount: view.unmount,
      flush: () => act(() => {
        const pending = [...frames.values()];
        frames.clear();
        for (const frame of pending) frame(performance.now());
      }),
    };
  }

  it("focuses the launcher after opening when focus has not moved", async () => {
    const opening = await pendingPanelOpening();
    expect(opening.opener).toHaveFocus();
    opening.flush();
    expect(screen.getByRole("group", { name: "Open a surface" })).toHaveFocus();
  });

  it.each(["Toggle terminal", "Other toolbar control"])(
    "preserves a newer %s focus while the panel opening frame is pending",
    async (name) => {
      const opening = await pendingPanelOpening();
      const target = screen.getByRole("button", { name });
      target.focus();
      opening.flush();
      expect(target).toHaveFocus();
    },
  );

  it("preserves focus after navigating away from and back to the opener", async () => {
    const opening = await pendingPanelOpening();
    screen.getByRole("button", { name: "Toggle terminal" }).focus();
    opening.opener.focus();
    opening.flush();
    expect(opening.opener).toHaveFocus();
  });

  it.each(["close", "unmount"] as const)(
    "cancels pending opening focus on %s",
    async (operation) => {
      const opening = await pendingPanelOpening();
      opening[operation]();
      expect(opening.frames.size).toBe(0);
      opening.flush();
      if (operation === "close") expect(opening.opener).toHaveFocus();
    },
  );

  it("shows a launcher with one-letter shortcuts when no surface is open", async () => {
    const onChange = vi.fn();
    render(<SurfaceHost initial={{ ...EMPTY_RIGHT_PANEL_STATE, isOpen: true }} onChange={onChange} />);

    const launcher = await screen.findByRole("group", { name: "Open a surface" });
    await waitFor(() => expect(launcher).toHaveFocus());
    expect(launcher).toHaveAttribute("aria-keyshortcuts", "D F B A U G P");
    // The terminal docks under the chat; the right panel never offers it.
    expect(within(launcher).queryByRole("button", { name: /^Terminal/u })).not.toBeInTheDocument();
    for (const label of ["Changes", "Files", "Browser", "Agents", "Usage"]) {
      expect(within(launcher).getByRole("button", { name: new RegExp(`^${label}`, "u") })).toBeVisible();
    }
    expect(within(launcher).getByRole("button", { name: /^Agents 2 running/u })).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();

    fireEvent.keyDown(launcher, { key: "u" });

    expect(await screen.findByRole("tab", { name: "Usage" })).toHaveAttribute("aria-selected", "true");
    expect(onChange).toHaveBeenLastCalledWith({
      isOpen: true,
      surfaces: ["usage"],
      activeSurfaceId: "usage",
    });
    expect(screen.getByRole("tabpanel", { name: "Usage" })).toHaveTextContent("usage content");
    expect(screen.queryByRole("group", { name: "Open a surface" })).not.toBeInTheDocument();
  });

  it("ignores launcher shortcuts while typing and explains unavailable surfaces", async () => {
    render(
      <>
        <input aria-label="Prompt" />
        <SurfaceHost
          initial={{ ...EMPTY_RIGHT_PANEL_STATE, isOpen: true }}
          unavailable={{ files: "Available after the first message creates this isolated worktree." }}
        />
      </>,
    );
    const launcher = await screen.findByRole("group", { name: "Open a surface" });
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    prompt.focus();
    fireEvent.keyDown(prompt, { key: "d" });
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();

    const files = within(launcher).getByText("Files").closest("[aria-disabled]");
    expect(files).toHaveAttribute("aria-disabled", "true");
    expect(files).toHaveAttribute("title", "Available after the first message creates this isolated worktree.");
    fireEvent.keyDown(document.body, { key: "f" });
    expect(screen.queryByRole("tab", { name: "Files" })).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "d" });
    expect(await screen.findByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
  });

  it("adds surfaces from the plus menu and keeps each tab closable", async () => {
    const onChange = vi.fn();
    render(<SurfaceHost initial={openState("changes")} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Add panel surface" }));
    const menu = await screen.findByRole("menu", { name: "Add panel surface" });
    fireEvent.click(await within(menu).findByRole("menuitem", { name: /^Browser/u }));
    expect(screen.queryByRole("menu", { name: "Add panel surface" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Add panel surface" }));
    const shortcutMenu = await screen.findByRole("menu", { name: "Add panel surface" });
    await within(shortcutMenu).findByRole("menuitem", { name: /^Agents/u });
    fireEvent.keyDown(shortcutMenu, { key: "a" });
    expect(screen.getByRole("tab", { name: "Agents 2" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-workspace-tab")))
      .toEqual(["changes", "preview", "agents"]);

    fireEvent.click(screen.getByRole("button", { name: "Close Browser" }));
    expect(screen.queryByRole("tab", { name: "Browser" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Agents 2" })).toHaveAttribute("aria-selected", "true");

    const agentsTab = screen.getByRole("tab", { name: "Agents 2" });
    fireEvent(agentsTab.parentElement!, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");

    const changes = screen.getByRole("tab", { name: "Changes" });
    changes.focus();
    fireEvent.keyDown(changes, { key: "Delete" });
    expect(onChange).toHaveBeenLastCalledWith({
      isOpen: false,
      surfaces: [],
      activeSurfaceId: null,
    });
  });

  it("starts the local chunk before activating a tab", () => {
    render(<SurfaceHost initial={openState("changes", "files")} />);
    const files = screen.getByRole("tab", { name: "Files" });

    fireEvent.pointerEnter(files);
    fireEvent.focus(files);

    expect(prefetchWorkspaceTool).toHaveBeenCalledWith("files");
    expect(prefetchWorkspaceTool).toHaveBeenCalledTimes(2);
  });

  it("moves and selects tabs with standard arrow, Home, and End keys", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const onChange = vi.fn();
    render(<SurfaceHost initial={openState("changes", "files", "preview")} onChange={onChange} />);
    const flushFocusFrame = () => {
      act(() => frames.shift()?.(performance.now()));
    };
    const changes = screen.getByRole("tab", { name: "Changes" });
    changes.focus();

    fireEvent.keyDown(changes, { key: "ArrowLeft" });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ activeSurfaceId: "preview" }));

    fireEvent.keyDown(screen.getByRole("tab", { name: "Browser" }), { key: "ArrowRight" });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Changes" }), { key: "End" });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Browser" }), { key: "Home" });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("tabindex", "-1");
  });

  it("closes a sheet with Escape and returns focus to the right panel toggle", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const onChange = vi.fn();
    render(
      <>
        <div data-panel-layout-controls>
          <button type="button" data-right-panel-toggle>Toggle right panel</button>
        </div>
        <SurfaceHost initial={openState("files")} presentation="sheet" onChange={onChange} />
      </>,
    );
    const panel = screen.getByRole("complementary", { name: "Workspace tools" });
    expect(panel).toHaveClass("is-sheet");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Files" }), { key: "Escape" });
    act(() => frames.shift()?.(performance.now()));

    expect(onChange).toHaveBeenLastCalledWith({
      isOpen: false,
      surfaces: ["files"],
      activeSurfaceId: "files",
    });
    expect(panel).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Toggle right panel" })).toHaveFocus();
  });

  it("keeps Escape inside an inline panel for the surface content", () => {
    const onChange = vi.fn();
    render(<SurfaceHost initial={openState("files")} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Files" }), { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("complementary", { name: "Workspace tools" })).toBeVisible();
  });
});
