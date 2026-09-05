import { useLayoutEffect, useSyncExternalStore } from "react";
import "../background-motion.css";

function documentPresenceSnapshot(): number {
  if (typeof document === "undefined") return 0;
  if (document.visibilityState !== "visible") return 0;
  return document.hasFocus() ? 2 : 1;
}

function subscribeDocumentPresence(onChange: () => void): () => void {
  const PRESENCE_EVENTS = [
    [document, "visibilitychange"],
    [window, "focus"],
    [window, "blur"],
  ] as const;
  for (const [target, event] of PRESENCE_EVENTS) {
    target.addEventListener(event, onChange);
  }
  return () => {
    for (const [target, event] of PRESENCE_EVENTS) {
      target.removeEventListener(event, onChange);
    }
  };
}

function documentVisibilitySnapshot(): boolean {
  return document.visibilityState === "visible";
}

function subscribeDocumentVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Keeps attention semantics (visible and focused) distinct from rendering
 * visibility. The primitive snapshot lets React ignore redundant browser
 * events without timers or an extra derived-state effect.
 */
export function useDocumentPresence(): number {
  const presence = useSyncExternalStore(
    subscribeDocumentPresence,
    documentPresenceSnapshot,
    documentPresenceSnapshot,
  );
  // The document root also covers portals and detached windows. Visible X11
  // windows can be unfocused, so visibility alone cannot suspend their motion.
  useLayoutEffect(() => {
    document.documentElement.dataset.documentActive = String(presence > 1);
    return () => { delete document.documentElement.dataset.documentActive; };
  }, [presence]);
  return presence;
}

function documentActivitySnapshot(): boolean {
  return documentPresenceSnapshot() > 1;
}

/** Schedules optional visual work only while the document is foregrounded. */
export function useDocumentActivity(): boolean {
  return useSyncExternalStore(
    subscribeDocumentPresence,
    documentActivitySnapshot,
    documentActivitySnapshot,
  );
}

/** Subscribes portal-only rendering work to the visibility boolean it needs. */
export function useDocumentVisibility(): boolean {
  return useSyncExternalStore(
    subscribeDocumentVisibility,
    documentVisibilitySnapshot,
    documentVisibilitySnapshot,
  );
}
