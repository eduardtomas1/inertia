import { useLayoutEffect, useRef } from "react";

import {
  installGlobalShortcuts,
  type GlobalShortcutActions,
} from "../utils/globalShortcuts";

export function useGlobalShortcuts(actions: GlobalShortcutActions): void {
  const currentActions = useRef(actions);
  useLayoutEffect(() => { currentActions.current = actions; });

  // The listener is installed exactly once. Its stable closure reads the
  // latest actions through the ref, so unrelated renders never re-bind it.
  // Capture owns application chords while the matcher preserves terminal Control keys.
  useLayoutEffect(() => {
    return installGlobalShortcuts(window, currentActions, window.inertia?.getPlatform() ?? "unknown");
  }, []);
}
