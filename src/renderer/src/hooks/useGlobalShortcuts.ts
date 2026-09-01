import { useLayoutEffect, useRef } from "react";

import {
  installGlobalShortcuts,
  type GlobalShortcutActions,
} from "../utils/globalShortcuts";

export function useGlobalShortcuts(actions: GlobalShortcutActions): void {
  const currentActions = useRef(actions);
  currentActions.current = actions;

  // The listener is installed exactly once. Its stable closure reads the
  // latest actions through the ref, so unrelated renders never re-bind it.
  // Capture is intentional so focused widgets such as xterm cannot consume
  // platform combinations like Ctrl+K first.
  useLayoutEffect(() => {
    return installGlobalShortcuts(window, currentActions);
  }, []);
}
