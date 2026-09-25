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
 * The bottom dock can stay open beside another surface. When Terminal is the
 * active surface, the same toolbar controls operate on it instead of opening
 * a second dock. Both locations retain workspace or split-pane ownership.
 */
export function useTerminalDock(
  scope: string | null,
  surfaceOpen = false,
  hideSurface?: (tool: null) => void,
): TerminalDockActions {
  const [persisted, setPersisted] = useState(() => ({ scope, open: storedOpen(scope) }));
  const dockOpen = persisted.scope === scope ? persisted.open : storedOpen(scope);
  const terminalOpen = surfaceOpen || dockOpen;

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

  return useMemo(() => {
    const closeTerminal = (): void => {
      update(() => false);
      if (surfaceOpen) hideSurface?.(null);
    };
    return {
      terminalOpen,
      openTerminal: () => { if (!surfaceOpen) update(() => true); },
      closeTerminal,
      toggleTerminal: () => {
        if (terminalOpen) closeTerminal();
        else update(() => true);
      },
    };
  }, [hideSurface, surfaceOpen, terminalOpen, update]);
}
