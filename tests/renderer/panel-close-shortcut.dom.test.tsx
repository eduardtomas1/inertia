import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installGlobalShortcuts,
  openPanelSurfaceChooser,
  type GlobalShortcutActions,
} from "../../src/renderer/src/utils/globalShortcuts";
import {
  CLOSE_ACTIVE_PANEL_SURFACE_EVENT,
  OPEN_PANEL_SURFACE_CHOOSER_EVENT,
} from "../../src/renderer/src/utils/rightPanelSurfaces";
import { DEFAULT_APP_KEYBINDINGS } from "../../src/shared/keybindings";

const actions = (): { current: GlobalShortcutActions } => ({
  current: {
    keybindings: DEFAULT_APP_KEYBINDINGS,
    createConversation: vi.fn(),
    mobileNavigation: false,
    suspended: false,
    toggleTerminal: vi.fn(),
    openSurfaceChooser: vi.fn(),
    setPaletteOpen: vi.fn(),
    setSidebarCollapsed: vi.fn(),
    setSidebarOpen: vi.fn(),
    toggleSettings: vi.fn(),
  },
});

function pane(name: string, hasTab = true): { root: HTMLElement; input: HTMLElement; closes: string[] } {
  const closes: string[] = [];
  const root = document.createElement("div");
  root.className = "conversation-pane-workspace";
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", `${name} composer`);
  const panel = document.createElement("aside");
  panel.className = "workspace-panel";
  panel.addEventListener(CLOSE_ACTIVE_PANEL_SURFACE_EVENT, (event) => {
    if (!hasTab) return;
    closes.push(name);
    event.preventDefault();
  });
  root.append(input, panel);
  document.body.append(root);
  return { root, input, closes };
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "w", code: "KeyW", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("closing the active panel tab from the keyboard", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
    document.body.replaceChildren();
  });

  it("uses Command+W on macOS and leaves Control+W alone", () => {
    const primary = pane("primary");
    dispose = installGlobalShortcuts(window, actions(), "darwin");

    expect(press(primary.input, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(primary.closes).toEqual([]);
    expect(press(primary.input, { metaKey: true }).defaultPrevented).toBe(true);
    expect(primary.closes).toEqual(["primary"]);
    expect(press(primary.input, { metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(primary.closes).toEqual(["primary"]);
  });

  it.each(["win32", "linux"])("uses Control+W on %s and leaves Meta+W alone", (platform) => {
    const primary = pane("primary");
    dispose = installGlobalShortcuts(window, actions(), platform);

    expect(press(primary.input, { metaKey: true }).defaultPrevented).toBe(false);
    expect(press(primary.input, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(primary.closes).toEqual(["primary"]);
  });

  it("closes in the pane that holds focus, or the first visible panel", () => {
    const primary = pane("primary");
    const secondary = pane("secondary");
    dispose = installGlobalShortcuts(window, actions(), "darwin");

    press(secondary.input, { metaKey: true });
    expect(secondary.closes).toEqual(["secondary"]);
    press(document.body, { metaKey: true });
    expect(primary.closes).toEqual(["primary"]);
    primary.root.querySelector(".workspace-panel")!.setAttribute("hidden", "");
    press(document.body, { metaKey: true });
    expect(secondary.closes).toEqual(["secondary", "secondary"]);
  });

  it("does nothing when focus is in a pane whose panel is closed", () => {
    const primary = pane("primary");
    const secondary = pane("secondary");
    secondary.root.querySelector(".workspace-panel")!.setAttribute("hidden", "");
    dispose = installGlobalShortcuts(window, actions(), "darwin");

    expect(press(secondary.input, { metaKey: true }).defaultPrevented).toBe(false);
    expect(primary.closes).toEqual([]);
    expect(secondary.closes).toEqual([]);
    secondary.root.querySelector(".workspace-panel")!.remove();
    expect(press(secondary.input, { metaKey: true }).defaultPrevented).toBe(false);
    expect(primary.closes).toEqual([]);
  });

  it("closes in the pane whose browser page holds focus, not the pane focused last", () => {
    const primary = pane("primary");
    const secondary = pane("secondary");
    const page = document.createElement("section");
    page.className = "preview-panel";
    page.dataset.pageFocused = "true";
    secondary.root.querySelector(".workspace-panel")!.append(page);
    dispose = installGlobalShortcuts(window, actions(), "darwin");

    press(primary.input, { metaKey: true });
    expect(secondary.closes).toEqual(["secondary"]);
    expect(primary.closes).toEqual([]);
  });

  it("treats an open native dialog as a modal", () => {
    const primary = pane("primary");
    dispose = installGlobalShortcuts(window, actions(), "darwin");
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(press(primary.input, { metaKey: true }).defaultPrevented).toBe(false);
    expect(primary.closes).toEqual([]);
  });

  it("matches the typed W rather than the physical key", () => {
    const primary = pane("primary");
    dispose = installGlobalShortcuts(window, actions(), "darwin");
    expect(press(primary.input, { metaKey: true, key: ",", code: "KeyW" }).defaultPrevented).toBe(false);
    expect(primary.closes).toEqual([]);
    expect(press(primary.input, { metaKey: true, key: "w", code: "KeyZ" }).defaultPrevented).toBe(true);
    expect(primary.closes).toEqual(["primary"]);
  });

  it("does nothing inside a terminal, under a modal, or with no tab to close", () => {
    const primary = pane("primary");
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    primary.root.append(terminal);
    dispose = installGlobalShortcuts(window, actions(), "darwin");

    expect(press(terminalInput, { metaKey: true }).defaultPrevented).toBe(false);
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    expect(press(primary.input, { metaKey: true }).defaultPrevented).toBe(false);
    modal.remove();
    expect(primary.closes).toEqual([]);

    document.body.replaceChildren();
    const empty = pane("empty", false);
    expect(press(empty.input, { metaKey: true }).defaultPrevented).toBe(false);
    document.body.replaceChildren();
    expect(press(document.body, { metaKey: true }).defaultPrevented).toBe(false);
  });

  it("does nothing while shortcuts are suspended", () => {
    const primary = pane("primary");
    const current = actions();
    current.current.suspended = true;
    dispose = installGlobalShortcuts(window, current, "darwin");
    expect(press(primary.input, { metaKey: true }).defaultPrevented).toBe(false);
    expect(primary.closes).toEqual([]);
  });
});

function chooserPane(owner: string, parent: HTMLElement = document.body): {
  root: HTMLElement;
  input: HTMLElement;
  panel: HTMLElement;
  requests: string[];
} {
  const requests: string[] = [];
  const root = document.createElement("div");
  root.className = "conversation-pane-workspace";
  root.dataset.paneOwner = owner;
  const input = document.createElement("textarea");
  const panel = document.createElement("aside");
  panel.className = "workspace-panel";
  panel.addEventListener(OPEN_PANEL_SURFACE_CHOOSER_EVENT, (event) => {
    if (panel.hidden) return;
    requests.push(owner);
    event.preventDefault();
  });
  root.append(input, panel);
  parent.append(root);
  return { root, input, panel, requests };
}

describe("opening the surface chooser from the keyboard", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it.each([
    ["darwin", { metaKey: true }, { ctrlKey: true }],
    ["linux", { ctrlKey: true }, { metaKey: true }],
    ["win32", { ctrlKey: true }, { metaKey: true }],
  ] as const)("runs the open-surface action with the primary modifier and G on %s", (platform, primary, other) => {
    const current = actions();
    dispose = installGlobalShortcuts(window, current, platform);
    const composer = document.createElement("textarea");
    document.body.append(composer);

    expect(press(composer, { ...other, key: "g", code: "KeyG" }).defaultPrevented).toBe(false);
    expect(current.current.openSurfaceChooser).not.toHaveBeenCalled();
    expect(press(composer, { ...primary, key: "g", code: "KeyG" }).defaultPrevented).toBe(true);
    expect(current.current.openSurfaceChooser).toHaveBeenCalledOnce();
    expect(press(composer, { ...primary, shiftKey: true, key: "g", code: "KeyG" }).defaultPrevented).toBe(false);
    expect(current.current.openSurfaceChooser).toHaveBeenCalledOnce();
  });

  it("follows a rebound key and stays out of terminals, modals and suspended overlays", () => {
    const current = actions();
    current.current.keybindings = { ...DEFAULT_APP_KEYBINDINGS, "open-surface": "y" };
    dispose = installGlobalShortcuts(window, current, "linux");
    const composer = document.createElement("textarea");
    document.body.append(composer);

    expect(press(composer, { ctrlKey: true, key: "g", code: "KeyG" }).defaultPrevented).toBe(false);
    expect(press(composer, { ctrlKey: true, key: "y", code: "KeyY" }).defaultPrevented).toBe(true);
    expect(current.current.openSurfaceChooser).toHaveBeenCalledOnce();

    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    expect(press(terminalInput, { ctrlKey: true, key: "y", code: "KeyY" }).defaultPrevented).toBe(false);

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    press(composer, { ctrlKey: true, key: "y", code: "KeyY" });
    modal.remove();
    current.current.suspended = true;
    press(composer, { ctrlKey: true, key: "y", code: "KeyY" });
    expect(current.current.openSurfaceChooser).toHaveBeenCalledOnce();
  });

  it("asks the focused pane's open panel first, then the main chat's panel", () => {
    const workspace = document.createElement("div");
    workspace.className = "workspace-body";
    document.body.append(workspace);
    const primary = chooserPane("primary", workspace);
    const secondary = chooserPane("secondary", workspace);
    const show = vi.fn(() => true);

    expect(openPanelSurfaceChooser(document, secondary.input, show)).toBe(true);
    expect(secondary.requests).toEqual(["secondary"]);
    expect(openPanelSurfaceChooser(document, null, show)).toBe(true);
    expect(primary.requests).toEqual(["primary"]);

    secondary.panel.hidden = true;
    expect(openPanelSurfaceChooser(document, secondary.input, show)).toBe(true);
    expect(primary.requests).toEqual(["primary", "primary"]);
    expect(secondary.requests).toEqual(["secondary"]);
    expect(show).not.toHaveBeenCalled();
  });

  it("asks the panel beside the chat when the window is not split", () => {
    const workspace = document.createElement("div");
    workspace.className = "workspace-body";
    const composer = document.createElement("textarea");
    const panel = document.createElement("aside");
    panel.className = "workspace-panel";
    const requests: Event[] = [];
    panel.addEventListener(OPEN_PANEL_SURFACE_CHOOSER_EVENT, (event) => {
      requests.push(event);
      event.preventDefault();
    });
    workspace.append(composer, panel);
    document.body.append(workspace);

    expect(openPanelSurfaceChooser(document, composer, () => false)).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("opens a closed main panel and asks it for the chooser on the next frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    const primary = chooserPane("primary");
    primary.panel.hidden = true;
    const show = vi.fn(() => {
      primary.panel.hidden = false;
      return true;
    });

    expect(openPanelSurfaceChooser(document, primary.input, show)).toBe(true);
    expect(show).toHaveBeenCalledOnce();
    expect(primary.requests).toEqual([]);
    frames.splice(0).forEach((frame) => frame(0));
    expect(primary.requests).toEqual(["primary"]);

    primary.panel.hidden = true;
    expect(openPanelSurfaceChooser(document, primary.input, () => false)).toBe(false);
    expect(frames).toEqual([]);
  });
});
