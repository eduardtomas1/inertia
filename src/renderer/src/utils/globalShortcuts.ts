export type WorkspaceShortcutTool =
  | "changes"
  | "files"
  | "terminal"
  | "plan"
  | "preview";

export interface GlobalShortcutActions {
  createConversation: () => void;
  mobileNavigation: boolean;
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
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
    options: boolean,
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
    options: boolean,
  ): void;
}

type CurrentActions = { current: GlobalShortcutActions };

export function installGlobalShortcuts(
  target: ShortcutTarget,
  actions: CurrentActions,
): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === "k") {
      event.preventDefault();
      actions.current.setPaletteOpen(true);
    } else if (key === "n") {
      event.preventDefault();
      actions.current.createConversation();
    } else if (key === "j") {
      event.preventDefault();
      actions.current.setActiveTool((tool) =>
        tool === "terminal" ? null : "terminal");
    } else if (key === "b") {
      event.preventDefault();
      if (actions.current.mobileNavigation) {
        actions.current.setSidebarOpen(true);
      } else {
        actions.current.setSidebarCollapsed((collapsed) => !collapsed);
      }
    }
  };

  target.addEventListener("keydown", handleKeyDown, true);
  return () => target.removeEventListener("keydown", handleKeyDown, true);
}
