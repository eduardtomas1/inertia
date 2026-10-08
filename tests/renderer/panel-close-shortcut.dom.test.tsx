import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installGlobalShortcuts,
  type GlobalShortcutActions,
} from "../../src/renderer/src/utils/globalShortcuts";
import { CLOSE_ACTIVE_PANEL_SURFACE_EVENT } from "../../src/renderer/src/utils/rightPanelSurfaces";
import { DEFAULT_APP_KEYBINDINGS } from "../../src/shared/keybindings";

const actions = (): { current: GlobalShortcutActions } => ({
  current: {
    keybindings: DEFAULT_APP_KEYBINDINGS,
    createConversation: vi.fn(),
    mobileNavigation: false,
    suspended: false,
    toggleTerminal: vi.fn(),
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
