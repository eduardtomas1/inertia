import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DetachedChatWindowOpenResult,
  DetachedChatWindowRequest,
  DetachedChatWindowSummary,
} from "@shared/desktop";
import { DETACHED_CHAT_WINDOW_LIMIT } from "@shared/desktop";

export interface DetachedChatWindowsController {
  ready: boolean;
  windows: readonly DetachedChatWindowSummary[];
  conversationIds: ReadonlySet<string>;
  atLimit: boolean;
  open: (
    request: DetachedChatWindowRequest,
  ) => Promise<DetachedChatWindowOpenResult>;
  focus: (conversationId: string) => Promise<boolean>;
}

/**
 * Owns the main renderer's presentation projection of native chat windows.
 * The main process remains authoritative; the initial invoke cannot overwrite
 * a newer lifecycle event that arrived while it was in flight.
 */
export function useDetachedChatWindows(): DetachedChatWindowsController {
  const [windows, setWindows] = useState<DetachedChatWindowSummary[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let lifecycleEventReceived = false;
    const accept = (next: DetachedChatWindowSummary[]): void => {
      if (disposed) return;
      lifecycleEventReceived = true;
      setWindows(next);
      setReady(true);
    };
    const unsubscribe = window.inertia.onDetachedChatWindowsChanged(accept);
    void window.inertia.getDetachedChatWindows().then((initial) => {
      if (!disposed && !lifecycleEventReceived) setWindows(initial);
    }).catch(() => undefined).finally(() => {
      if (!disposed) setReady(true);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const open = useCallback((request: DetachedChatWindowRequest) =>
    window.inertia.openDetachedChat(request), []);
  const focus = useCallback((conversationId: string) =>
    window.inertia.focusDetachedChat(conversationId), []);
  const conversationIds = useMemo(
    () => new Set(windows.map(({ conversationId }) => conversationId)),
    [windows],
  );

  return useMemo(() => ({
    ready,
    windows,
    conversationIds,
    atLimit: windows.length >= DETACHED_CHAT_WINDOW_LIMIT,
    open,
    focus,
  }), [conversationIds, focus, open, ready, windows]);
}
