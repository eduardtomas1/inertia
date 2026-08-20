import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DetachedChatWindowOpenResult,
  DetachedChatWindowOpenRequest,
  DetachedChatWindowSummary,
} from "@shared/desktop";
import { DETACHED_CHAT_WINDOW_LIMIT } from "@shared/desktop";

export interface DetachedChatWindowsController {
  ready: boolean;
  windows: readonly DetachedChatWindowSummary[];
  conversationIds: ReadonlySet<string>;
  atLimit: boolean;
  open: (
    request: DetachedChatWindowOpenRequest,
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
  const [windowsReady, setWindowsReady] = useState(false);
  const [draftsReady, setDraftsReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let lifecycleEventReceived = false;
    const accept = (next: DetachedChatWindowSummary[]): void => {
      if (disposed) return;
      lifecycleEventReceived = true;
      setWindows(next);
      setWindowsReady(true);
    };
    const unsubscribe = window.inertia.onDetachedChatWindowsChanged(accept);
    void window.inertia.getDetachedChatWindows().then((initial) => {
      if (!disposed && !lifecycleEventReceived) setWindows(initial);
    }).catch(() => undefined).finally(() => {
      if (!disposed) setWindowsReady(true);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let hydrating = true;
    const latestEvent = new Map<string, string>();
    const accept = (handoff: Awaited<ReturnType<
      typeof window.inertia.getPendingDetachedChatDrafts
    >>[number]): void => {
      if (disposed) return;
      try {
        const key = `inertia:draft:${handoff.conversationId}`;
        if (handoff.draft) window.localStorage.setItem(key, handoff.draft);
        else window.localStorage.removeItem(key);
      } catch {
        return;
      }
      void window.inertia.acknowledgeDetachedChatDraft({
        conversationId: handoff.conversationId,
        handoffId: handoff.handoffId,
      }).catch(() => undefined);
    };
    const unsubscribe = window.inertia.onDetachedChatDraftChanged((handoff) => {
      if (hydrating) latestEvent.set(handoff.conversationId, handoff.handoffId);
      accept(handoff);
    });
    void window.inertia.getPendingDetachedChatDrafts().then((pending) => {
      for (const handoff of pending) {
        const newerEvent = latestEvent.get(handoff.conversationId);
        if (!newerEvent || newerEvent === handoff.handoffId) accept(handoff);
      }
    }).catch(() => undefined).finally(() => {
      hydrating = false;
      if (!disposed) setDraftsReady(true);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const open = useCallback((request: DetachedChatWindowOpenRequest) =>
    window.inertia.openDetachedChat(request), []);
  const focus = useCallback((conversationId: string) =>
    window.inertia.focusDetachedChat(conversationId), []);
  const conversationIds = useMemo(
    () => new Set(windows.map(({ conversationId }) => conversationId)),
    [windows],
  );

  return useMemo(() => ({
    ready: windowsReady && draftsReady,
    windows,
    conversationIds,
    atLimit: windows.length >= DETACHED_CHAT_WINDOW_LIMIT,
    open,
    focus,
  }), [conversationIds, draftsReady, focus, open, windows, windowsReady]);
}
