import { useSyncExternalStore } from "react";

const PRESENCE_EVENTS = [
  [document, "visibilitychange"],
  [window, "focus"],
  [window, "blur"],
] as const;

function documentPresenceSnapshot(): number {
  if (document.visibilityState !== "visible") return 0;
  return document.hasFocus() ? 2 : 1;
}

function subscribeDocumentPresence(onChange: () => void): () => void {
  for (const [target, event] of PRESENCE_EVENTS) {
    target.addEventListener(event, onChange);
  }
  return () => {
    for (const [target, event] of PRESENCE_EVENTS) {
      target.removeEventListener(event, onChange);
    }
  };
}

/**
 * Keeps attention semantics (visible and focused) distinct from rendering
 * visibility. The primitive snapshot lets React ignore redundant browser
 * events without timers or an extra derived-state effect.
 */
export function useDocumentPresence(): number {
  return useSyncExternalStore(
    subscribeDocumentPresence,
    documentPresenceSnapshot,
    documentPresenceSnapshot,
  );
}
