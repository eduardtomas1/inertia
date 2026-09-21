import { useCallback, useMemo, useState } from "react";

import { layoutStorage } from "../utils/layoutStorage";

export interface TerminalDockActions {
  terminalOpen: boolean;
  openTerminal: () => void;
  closeTerminal: () => void;
  toggleTerminal: () => void;
}

export function terminalDockStorageKey(scope: string): string {
  return `inertia:layout:terminal-dock:${encodeURIComponent(scope)}:v1`;
}

function storedOpen(scope: string | null): boolean {
  return scope !== null && layoutStorage.getItem(terminalDockStorageKey(scope)) === "open";
}

/**
 * The terminal docks under the chat, independent of the right panel, so a
 * surface such as Changes can stay open beside it. Open state is kept per
 * workspace or split-pane scope, like the panel state.
 */
export function useTerminalDock(scope: string | null): TerminalDockActions {
  const [persisted, setPersisted] = useState(() => ({ scope, open: storedOpen(scope) }));
  const terminalOpen = persisted.scope === scope ? persisted.open : storedOpen(scope);

  const update = useCallback((next: (open: boolean) => boolean) => {
    setPersisted((current) => {
      const open = next(current.scope === scope ? current.open : storedOpen(scope));
      if (scope !== null) {
        if (open) layoutStorage.setItem(terminalDockStorageKey(scope), "open");
        else layoutStorage.removeItem(terminalDockStorageKey(scope));
      }
      return { scope, open };
    });
  }, [scope]);

  return useMemo(() => ({
    terminalOpen,
    openTerminal: () => update(() => true),
    closeTerminal: () => update(() => false),
    toggleTerminal: () => update((open) => !open),
  }), [terminalOpen, update]);
}
