import { useSyncExternalStore } from "react";

const COMPOSER_TOOLS_STORAGE_KEY = "inertia:composer-tools:v1";
const listeners = new Set<() => void>();
let unstoredOpen: boolean | null = null;

function composerToolsOpen(): boolean {
  if (unstoredOpen !== null) return unstoredOpen;
  try {
    return window.localStorage.getItem(COMPOSER_TOOLS_STORAGE_KEY) === "open";
  } catch {
    return false;
  }
}

function storeComposerToolsOpen(open: boolean): boolean {
  const value = open ? "open" : "closed";
  try {
    window.localStorage.setItem(COMPOSER_TOOLS_STORAGE_KEY, value);
    return window.localStorage.getItem(COMPOSER_TOOLS_STORAGE_KEY) === value;
  } catch {
    return false;
  }
}

function subscribeComposerTools(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== COMPOSER_TOOLS_STORAGE_KEY) return;
    unstoredOpen = null;
    listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setComposerToolsOpen(open: boolean): void {
  unstoredOpen = storeComposerToolsOpen(open) ? null : open;
  for (const listener of listeners) listener();
}

export function useComposerToolsOpen(): boolean {
  return useSyncExternalStore(subscribeComposerTools, composerToolsOpen);
}
