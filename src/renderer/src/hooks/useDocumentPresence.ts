import { useSyncExternalStore } from "react";

const DOCUMENT_HIDDEN = 0;
const DOCUMENT_VISIBLE_UNFOCUSED = 1;
const DOCUMENT_VISIBLE_FOCUSED = 2;

function documentPresenceSnapshot(): number {
  if (document.visibilityState !== "visible") return DOCUMENT_HIDDEN;
  return document.hasFocus()
    ? DOCUMENT_VISIBLE_FOCUSED
    : DOCUMENT_VISIBLE_UNFOCUSED;
}

function subscribeDocumentPresence(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

export interface DocumentPresence {
  documentActive: boolean;
  documentVisible: boolean;
}

/**
 * Keeps attention semantics (visible and focused) distinct from rendering
 * visibility. The primitive snapshot lets React ignore redundant browser
 * events without timers or an extra derived-state effect.
 */
export function useDocumentPresence(): DocumentPresence {
  const snapshot = useSyncExternalStore(
    subscribeDocumentPresence,
    documentPresenceSnapshot,
    documentPresenceSnapshot,
  );
  return {
    documentActive: snapshot === DOCUMENT_VISIBLE_FOCUSED,
    documentVisible: snapshot !== DOCUMENT_HIDDEN,
  };
}
