import { useEffect, useRef } from "react";

import type { GlobalShortcutActions } from "../utils/globalShortcuts";

export function useGlobalShortcuts(actions: GlobalShortcutActions): void {
  const currentActions = useRef(actions);
  currentActions.current = actions;

  // The listener is installed exactly once. Its stable closure reads the
  // latest actions through the ref, so unrelated renders never re-bind it.
  // Capture is intentional so focused widgets such as xterm cannot consume
  // platform combinations like Ctrl+K first.
  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    void import("../utils/globalShortcuts").then(({ installGlobalShortcuts }) => {
      if (active) dispose = installGlobalShortcuts(window, currentActions);
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, []);
}
