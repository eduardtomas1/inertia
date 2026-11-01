import { useLayoutEffect, useRef } from "react";
import type { AppKeybindings } from "@shared/keybindings";

import {
  installGlobalShortcuts,
  installWindowCloseShortcut,
  type GlobalShortcutActions,
} from "../../utils/globalShortcuts";

export interface DetachedShortcutActions {
  keybindings: AppKeybindings;
  toggleTerminal: () => void;
  createConversation: () => void;
  openSettings: () => void;
  closeWindow: () => void;
}

const ignore = (): void => undefined;

export function detachedGlobalShortcutActions(
  actions: DetachedShortcutActions,
): GlobalShortcutActions {
  return {
    keybindings: actions.keybindings,
    createConversation: actions.createConversation,
    mobileNavigation: false,
    suspended: false,
    toggleTerminal: actions.toggleTerminal,
    setPaletteOpen: ignore,
    setSidebarCollapsed: ignore,
    setSidebarOpen: ignore,
    toggleSettings: actions.openSettings,
    openTasks: ignore,
    openSurfaceChooser: ignore,
  };
}

export function useDetachedShortcuts(actions: DetachedShortcutActions): void {
  const current = useRef(detachedGlobalShortcutActions(actions));
  const closeWindow = useRef(actions.closeWindow);
  useLayoutEffect(() => {
    current.current = detachedGlobalShortcutActions(actions);
    closeWindow.current = actions.closeWindow;
  });
  useLayoutEffect(() => {
    const platform = window.inertia?.getPlatform?.() ?? "unknown";
    const removeGlobal = installGlobalShortcuts(window, current, platform);
    const removeClose = installWindowCloseShortcut(window, platform, () => closeWindow.current());
    return () => {
      removeClose();
      removeGlobal();
    };
  }, []);
}
