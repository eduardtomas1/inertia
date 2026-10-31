export interface GlobalShortcutActions {
  keybindings: AppKeybindings;
  createConversation: () => void;
  mobileNavigation: boolean;
  suspended: boolean;
  toggleTerminal: () => void;
  openSurfaceChooser: () => void;
  setPaletteOpen: (open: boolean) => void;
  setSidebarCollapsed: (
    update: boolean | ((collapsed: boolean) => boolean),
  ) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSettings: () => void;
  openTasks: () => void;
}

interface ShortcutTarget {
  addEventListener(
    type: "keydown" | "keyup",
    listener: (event: KeyboardEvent) => void,
    options: boolean,
  ): void;
  removeEventListener(
    type: "keydown" | "keyup",
    listener: (event: KeyboardEvent) => void,
    options: boolean,
  ): void;
}

type CurrentActions = { current: GlobalShortcutActions };

const PANE_SELECTOR = ".conversation-pane-workspace, .workspace-body";
const PRIMARY_PANE_SELECTOR = '.conversation-pane-workspace[data-pane-owner="primary"]';
const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], dialog[open]';

function paneOwnPanel(pane: Element): HTMLElement | null {
  return Array.from(pane.querySelectorAll<HTMLElement>(".workspace-panel"))
    .find((entry) => entry.closest(PANE_SELECTOR) === pane) ?? null;
}

function primaryPanel(ownerDocument: Document): HTMLElement | null {
  const pane = ownerDocument.querySelector(PRIMARY_PANE_SELECTOR)
    ?? ownerDocument.querySelector(".workspace-body");
  return pane ? paneOwnPanel(pane) : null;
}

function requestSurfaceChooser(panel: HTMLElement | null): boolean {
  if (!panel || panel.hidden) return false;
  return !panel.dispatchEvent(new Event(OPEN_PANEL_SURFACE_CHOOSER_EVENT, { cancelable: true }));
}

/**
 * Shows the surface chooser in the focused pane's panel when that panel is
 * open, otherwise in the main chat's panel. A closed main panel is opened
 * first through `showPrimaryPanel`, which reports whether it opened one.
 */
export function openPanelSurfaceChooser(
  ownerDocument: Document,
  origin: Element | null,
  showPrimaryPanel: () => boolean,
): boolean {
  const pane = origin?.closest(PANE_SELECTOR) ?? null;
  if (pane && requestSurfaceChooser(paneOwnPanel(pane))) return true;
  if (requestSurfaceChooser(primaryPanel(ownerDocument))) return true;
  if (!showPrimaryPanel()) return false;
  // The panel renders on the next commit; ask it once it is shown.
  ownerDocument.defaultView?.requestAnimationFrame(() => {
    requestSurfaceChooser(primaryPanel(ownerDocument));
  });
  return true;
}

function isCloseTabChord(event: KeyboardEvent, platform: string): boolean {
  const primaryModifier = platform === "darwin"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return primaryModifier
    && event.key.toLowerCase() === "w"
    && !event.altKey
    && !event.shiftKey
    && !event.isComposing;
}

/**
 * Where a panel shortcut came from: a Browser page that holds focus (its
 * native view takes keyboard focus away from the document), otherwise the
 * event target or focused element.
 */
export function panelShortcutOrigin(ownerDocument: Document, target: EventTarget | null): Element | null {
  return ownerDocument.querySelector(".preview-panel[data-page-focused]")
    ?? (target instanceof Element ? target : target instanceof Node ? target.parentElement : null);
}

function closeActivePanelSurface(ownerDocument: Document, target: EventTarget | null): boolean {
  const origin = panelShortcutOrigin(ownerDocument, target);
  const pane = origin?.closest(PANE_SELECTOR) ?? null;
  const panel = pane
    ? paneOwnPanel(pane)
    : ownerDocument.querySelector<HTMLElement>(".workspace-panel:not([hidden])");
  if (!panel || panel.hidden) return false;
  return !panel.dispatchEvent(new Event(CLOSE_ACTIVE_PANEL_SURFACE_EVENT, { cancelable: true }));
}

export function installWindowCloseShortcut(
  target: Window,
  platform: string,
  closeWindow: () => void,
): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!isCloseTabChord(event, platform) || event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest(".xterm")) return;
    const ownerDocument = target.document;
    if (ownerDocument.querySelector(MODAL_SELECTOR)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!closeActivePanelSurface(ownerDocument, event.target)) closeWindow();
  };
  target.addEventListener("keydown", handleKeyDown, true);
  return () => target.removeEventListener("keydown", handleKeyDown, true);
}

export function installGlobalShortcuts(
  target: ShortcutTarget,
  actions: CurrentActions,
  platform = "linux",
): () => void {
  // xterm refocuses itself on non-modifier keyup. Own the matching release as
  // well as the shortcut press so an overlay opened from the terminal keeps
  // focus, even when the user releases the modifier first.
  const ownedKeyUps = new Set<string>();
  const physicalKey = (event: KeyboardEvent): string =>
    /^Key[A-Z]$/u.test(event.code ?? "") ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
  const handleKeyDown = (event: KeyboardEvent): void => {
    const key = physicalKey(event);
    const primaryModifier = platform === "darwin"
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!primaryModifier) {
      ownedKeyUps.delete(key);
      return;
    }
    if (event.altKey || event.shiftKey || event.isComposing) return;
    // Readline and tmux own Control chords in terminal input. macOS Command
    // chords remain available because they do not encode terminal controls.
    const terminalTarget = typeof Element !== "undefined"
      && event.target instanceof Element && event.target.closest(".xterm");
    if (isCloseTabChord(event, platform)) {
      const closeDocument = typeof Node !== "undefined" && event.target instanceof Node
        ? event.target.ownerDocument
        : typeof document !== "undefined" ? document : null;
      if (terminalTarget || actions.current.suspended || !closeDocument) return;
      if (closeDocument.querySelector(MODAL_SELECTOR)) return;
      if (!closeActivePanelSurface(closeDocument, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      return;
    }
    if (event.ctrlKey && terminalTarget) return;
    const shortcut: AppShortcutAction | "toggle-settings" | undefined = key === "," || event.code === "Comma"
      ? "toggle-settings"
      : (Object.keys(actions.current.keybindings) as AppShortcutAction[])
        .find((action) => actions.current.keybindings[action] === key);
    const ownerDocument = typeof Node !== "undefined" && event.target instanceof Node
      ? event.target.ownerDocument
      : typeof document !== "undefined" ? document : null;
    const modalOpen = Boolean(ownerDocument?.querySelector(
      '[role="dialog"][aria-modal="true"]',
    ));
    if (shortcut && (event.repeat || actions.current.suspended || modalOpen)) {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      return;
    }
    if (shortcut === "search") {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      actions.current.setPaletteOpen(true);
    } else if (shortcut === "new-chat") {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      actions.current.createConversation();
    } else if (shortcut === "toggle-terminal") {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      actions.current.toggleTerminal();
    } else if (shortcut === "tasks") {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      actions.current.openTasks();
    } else if (shortcut === "open-surface") {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      actions.current.openSurfaceChooser();
    } else if (shortcut === "toggle-settings") {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      actions.current.toggleSettings();
    } else if (shortcut === "toggle-sidebar") {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      if (actions.current.mobileNavigation) {
        actions.current.setSidebarOpen(true);
      } else {
        actions.current.setSidebarCollapsed((collapsed) => !collapsed);
      }
    }
  };
  const handleKeyUp = (event: KeyboardEvent): void => {
    const key = physicalKey(event);
    if (!ownedKeyUps.delete(key)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  target.addEventListener("keydown", handleKeyDown, true);
  target.addEventListener("keyup", handleKeyUp, true);
  return () => {
    ownedKeyUps.clear();
    target.removeEventListener("keydown", handleKeyDown, true);
    target.removeEventListener("keyup", handleKeyUp, true);
  };
}
import type {
  AppKeybindings,
  AppShortcutAction,
} from "@shared/keybindings";
import {
  CLOSE_ACTIVE_PANEL_SURFACE_EVENT,
  OPEN_PANEL_SURFACE_CHOOSER_EVENT,
} from "./rightPanelSurfaces";
