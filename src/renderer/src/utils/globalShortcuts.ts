export type WorkspaceShortcutTool =
  | "changes"
  | "files"
  | "terminal"
  | "goal"
  | "plan"
  | "preview";

export interface GlobalShortcutActions {
  createConversation: () => void;
  mobileNavigation: boolean;
  suspended: boolean;
  setActiveTool: (
    update: WorkspaceShortcutTool
      | null
      | ((tool: WorkspaceShortcutTool | null) => WorkspaceShortcutTool | null),
  ) => void;
  setPaletteOpen: (open: boolean) => void;
  setSidebarCollapsed: (
    update: boolean | ((collapsed: boolean) => boolean),
  ) => void;
  setSidebarOpen: (open: boolean) => void;
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

export function installGlobalShortcuts(
  target: ShortcutTarget,
  actions: CurrentActions,
): () => void {
  // xterm refocuses itself on non-modifier keyup. Own the matching release as
  // well as the shortcut press so an overlay opened from the terminal keeps
  // focus, even when the user releases the modifier first.
  const ownedKeyUps = new Set<string>();
  const handleKeyDown = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (!(event.metaKey || event.ctrlKey)) {
      ownedKeyUps.delete(key);
      return;
    }
    const shortcutKey = ["b", "j", "k", "n"].includes(key);
    const ownerDocument = typeof Node !== "undefined" && event.target instanceof Node
      ? event.target.ownerDocument
      : typeof document !== "undefined" ? document : null;
    const modalOpen = Boolean(ownerDocument?.querySelector(
      '[role="dialog"][aria-modal="true"]',
    ));
    if (shortcutKey && (actions.current.suspended || modalOpen)) {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      return;
    }
    if (key === "k") {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      actions.current.setPaletteOpen(true);
    } else if (key === "n") {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      actions.current.createConversation();
    } else if (key === "j") {
      event.preventDefault();
      event.stopPropagation();
      ownedKeyUps.add(key);
      actions.current.setActiveTool((tool) =>
        tool === "terminal" ? null : "terminal");
    } else if (key === "b") {
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
    const key = event.key.toLowerCase();
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
