import { useCallback, useMemo, useSyncExternalStore } from "react";

import { layoutStorage } from "../utils/layoutStorage";

interface WatcherDockRecord {
  open: boolean;
  seenAt: string | null;
  seenFindings: number | null;
}

type WatcherDockPresentation = "inline" | "sheet";

interface WatcherDockState {
  open: boolean;
  seenAt: string | null;
  seenFindings: number | null;
  presentation: WatcherDockPresentation;
  motion: number;
}

export interface WatcherDockController extends WatcherDockState {
  setOpen: (open: boolean, options?: { focusHeading?: boolean }) => void;
  markSeen: (at: string, findings: number) => void;
}

const STORAGE_PREFIX = "inertia:layout:watcher-dock:";
const CLOSED_STATE: WatcherDockState = Object.freeze({
  open: false, seenAt: null, seenFindings: null, presentation: "inline", motion: 0,
});
const OPEN_RECORD: WatcherDockRecord = Object.freeze({ open: true, seenAt: null, seenFindings: null });
const records = new Map<string, WatcherDockRecord>();
const presentations = new Map<string, WatcherDockPresentation>();
const sheetOpen = new Map<string, boolean>();
const openRequests = new Map<string, number>();
const OPEN_REQUEST_MS = 1_000;
const motions = new Map<string, number>();
const states = new Map<string, WatcherDockState>();
const focusTokens = new Map<string, number>();
const consumedFocusTokens = new Map<string, number>();
const errors = new Map<string, { message: string; token: number }>();
const listeners = new Set<() => void>();
let errorSequence = 0;
let storageListening = false;

export function watcherDockStorageKey(watchedId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(watchedId)}:v1`;
}

function watchedIdForKey(key: string): string | null {
  if (!key.startsWith(STORAGE_PREFIX) || !key.endsWith(":v1")) return null;
  try {
    return decodeURIComponent(key.slice(STORAGE_PREFIX.length, -":v1".length));
  } catch {
    return null;
  }
}

export function readWatcherDock(watchedId: string): WatcherDockRecord {
  let record = records.get(watchedId);
  if (!record) {
    record = OPEN_RECORD;
    try {
      const stored = JSON.parse(layoutStorage.getItem(watcherDockStorageKey(watchedId)) ?? "null") as Partial<WatcherDockRecord> | null;
      if (stored) {
        record = {
          open: stored.open !== false,
          seenAt: typeof stored.seenAt === "string" ? stored.seenAt : null,
          seenFindings: typeof stored.seenFindings === "number" ? stored.seenFindings : null,
        };
      }
    } catch {
    }
    records.set(watchedId, record);
  }
  return record;
}

function readState(watchedId: string): WatcherDockState {
  const cached = states.get(watchedId);
  if (cached) return cached;
  const record = readWatcherDock(watchedId);
  const presentation = presentations.get(watchedId) ?? "inline";
  const state: WatcherDockState = {
    open: presentation === "sheet" ? sheetOpen.get(watchedId) === true : record.open,
    seenAt: record.seenAt,
    seenFindings: record.seenFindings,
    presentation,
    motion: motions.get(watchedId) ?? 0,
  };
  states.set(watchedId, state);
  return state;
}

function notify(watchedId?: string): void {
  if (watchedId === undefined) states.clear();
  else states.delete(watchedId);
  for (const listener of listeners) listener();
}

function writeWatcherDock(watchedId: string, next: WatcherDockRecord): void {
  records.set(watchedId, next);
  layoutStorage.setItem(watcherDockStorageKey(watchedId), JSON.stringify(next));
  notify(watchedId);
}

export function setWatcherDockOpen(
  watchedId: string,
  open: boolean,
  options: { focusHeading?: boolean } = {},
): void {
  const current = readState(watchedId);
  const focus = open && options.focusHeading === true;
  if (open) openRequests.set(watchedId, Date.now());
  else openRequests.delete(watchedId);
  if (focus) focusTokens.set(watchedId, (focusTokens.get(watchedId) ?? 0) + 1);
  if (current.open === open) {
    if (focus) notify(watchedId);
    return;
  }
  motions.set(watchedId, (motions.get(watchedId) ?? 0) + 1);
  if (current.presentation === "sheet") {
    sheetOpen.set(watchedId, open);
    notify(watchedId);
    return;
  }
  writeWatcherDock(watchedId, { ...readWatcherDock(watchedId), open });
}

export function setWatcherDockPresentation(watchedId: string, presentation: WatcherDockPresentation): void {
  const prior = presentations.get(watchedId);
  if (prior === presentation) return;
  presentations.set(watchedId, presentation);
  const requestedAt = openRequests.get(watchedId);
  openRequests.delete(watchedId);
  if (presentation === "sheet") {
    const requested = requestedAt !== undefined && Date.now() - requestedAt <= OPEN_REQUEST_MS;
    sheetOpen.set(watchedId, requested && readWatcherDock(watchedId).open);
    notify(watchedId);
    return;
  }
  const wasOpen = prior === "sheet" && sheetOpen.get(watchedId) === true;
  sheetOpen.delete(watchedId);
  const record = readWatcherDock(watchedId);
  if (wasOpen && !record.open) writeWatcherDock(watchedId, { ...record, open: true });
  else notify(watchedId);
}

export function consumeWatcherDockFocus(watchedId: string): boolean {
  const token = focusTokens.get(watchedId) ?? 0;
  if (token <= (consumedFocusTokens.get(watchedId) ?? 0)) return false;
  consumedFocusTokens.set(watchedId, token);
  return true;
}

export function cancelWatcherDockFocus(watchedId: string): void {
  consumedFocusTokens.set(watchedId, focusTokens.get(watchedId) ?? 0);
}

export function watcherDockFocusToken(watchedId: string): number {
  return focusTokens.get(watchedId) ?? 0;
}

export function reportWatcherDockError(watchedId: string, message: string): void {
  errorSequence += 1;
  errors.set(watchedId, { message, token: errorSequence });
  setWatcherDockOpen(watchedId, true, { focusHeading: true });
  notify(watchedId);
}

export function watcherDockErrorToken(watchedId: string): number {
  return errors.get(watchedId)?.token ?? 0;
}

export function takeWatcherDockError(watchedId: string): string | null {
  const error = errors.get(watchedId);
  if (!error) return null;
  errors.delete(watchedId);
  return error.message;
}

function onStorage(event: StorageEvent): void {
  if (event.key === null) {
    records.clear();
    notify();
    return;
  }
  const watchedId = watchedIdForKey(event.key);
  if (watchedId === null) return;
  records.delete(watchedId);
  notify(watchedId);
}

export function subscribeWatcherDock(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListening && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    storageListening = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageListening) {
      window.removeEventListener("storage", onStorage);
      storageListening = false;
    }
  };
}

export function useWatcherDock(watchedId: string | null): WatcherDockController {
  const read = useCallback(() => watchedId ? readState(watchedId) : CLOSED_STATE, [watchedId]);
  const state = useSyncExternalStore(subscribeWatcherDock, read, read);
  const setOpen = useCallback((open: boolean, options?: { focusHeading?: boolean }) => {
    if (watchedId) setWatcherDockOpen(watchedId, open, options);
  }, [watchedId]);
  const markSeen = useCallback((at: string, findings: number) => {
    const current = watchedId ? readWatcherDock(watchedId) : null;
    if (watchedId && current && (current.seenAt === null || current.seenAt < at || current.seenFindings !== findings)) {
      writeWatcherDock(watchedId, { ...current, seenAt: at, seenFindings: findings });
    }
  }, [watchedId]);
  return useMemo(() => ({ ...state, setOpen, markSeen }), [markSeen, setOpen, state]);
}

export function resetWatcherDockStore(): void {
  records.clear();
  presentations.clear();
  sheetOpen.clear();
  openRequests.clear();
  motions.clear();
  states.clear();
  focusTokens.clear();
  consumedFocusTokens.clear();
  errors.clear();
}
