import { useSyncExternalStore } from "react";

import { layoutStorage } from "../utils/layoutStorage";

const COMPOSER_TOOLS_STORAGE_KEY = "inertia:composer-tools:v1";
const listeners = new Set<() => void>();
let unstoredOpen = false;

function composerToolsOpen(): boolean {
  try {
    return window.localStorage.getItem(COMPOSER_TOOLS_STORAGE_KEY) === "open";
  } catch {
    return unstoredOpen;
  }
}

function subscribeComposerTools(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === COMPOSER_TOOLS_STORAGE_KEY) listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setComposerToolsOpen(open: boolean): void {
  unstoredOpen = open;
  layoutStorage.setItem(COMPOSER_TOOLS_STORAGE_KEY, open ? "open" : "closed");
  for (const listener of listeners) listener();
}

export function useComposerToolsOpen(): boolean {
  return useSyncExternalStore(subscribeComposerTools, composerToolsOpen);
}
