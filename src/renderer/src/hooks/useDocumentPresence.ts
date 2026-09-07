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
  return typeof document !== "undefined" && document.visibilityState === "visible";
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
  // The document root covers portals and detached windows. Attention needs
  // focus, but visible unfocused windows must keep their progress motion live.
  useLayoutEffect(() => {
    document.documentElement.dataset.documentActive = String(presence > 1);
    document.documentElement.dataset.documentVisible = String(presence > 0);
    return () => {
      delete document.documentElement.dataset.documentActive;
      delete document.documentElement.dataset.documentVisible;
    };
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

/** Keeps visible rendering live without subscribing it to attention changes. */
export function useDocumentVisibility(): boolean {
  return useSyncExternalStore(
    subscribeDocumentVisibility,
    documentVisibilitySnapshot,
    documentVisibilitySnapshot,
  );
}
