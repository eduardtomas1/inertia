import { useCallback, useMemo, useSyncExternalStore } from "react";

import { layoutStorage } from "../utils/layoutStorage";

/**
 * Per watched chat: whether its dock is open and the newest finding already
 * seen. The composer chip and the dock read the same record, so they always
 * agree. Eager and deliberately small; the dock itself is lazy.
 */
export interface WatcherDockRecord {
  open: boolean;
  seenAt: string | null;
}

export interface WatcherDockController extends WatcherDockRecord {
  setOpen: (open: boolean, options?: { focusHeading?: boolean }) => void;
  markSeen: (at: string) => void;
}

const CLOSED_RECORD: WatcherDockRecord = Object.freeze({ open: false, seenAt: null });
const OPEN_RECORD: WatcherDockRecord = Object.freeze({ open: true, seenAt: null });
const records = new Map<string, WatcherDockRecord>();
const focusTokens = new Map<string, number>();
const consumedFocusTokens = new Map<string, number>();
const listeners = new Set<() => void>();

export function watcherDockStorageKey(watchedId: string): string {
  return `inertia:layout:watcher-dock:${encodeURIComponent(watchedId)}:v1`;
}

/** Open by default: a new watcher's dock opens beside its chat. */
export function readWatcherDock(watchedId: string): WatcherDockRecord {
  let record = records.get(watchedId);
  if (!record) {
    record = OPEN_RECORD;
    try {
      const stored = JSON.parse(layoutStorage.getItem(watcherDockStorageKey(watchedId)) ?? "null") as Partial<WatcherDockRecord> | null;
      if (stored) record = { open: stored.open !== false, seenAt: typeof stored.seenAt === "string" ? stored.seenAt : null };
    } catch {
      // Layout preferences are optional; fall back to an open dock.
    }
    records.set(watchedId, record);
  }
  return record;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function writeWatcherDock(watchedId: string, next: WatcherDockRecord): void {
  records.set(watchedId, next);
  layoutStorage.setItem(watcherDockStorageKey(watchedId), JSON.stringify(next));
  notify();
}

/** Opens or collapses a dock; opening can also ask it to focus its heading. */
export function setWatcherDockOpen(
  watchedId: string,
  open: boolean,
  options: { focusHeading?: boolean } = {},
): void {
  const current = readWatcherDock(watchedId);
  const focus = open && options.focusHeading === true;
  if (focus) focusTokens.set(watchedId, (focusTokens.get(watchedId) ?? 0) + 1);
  if (current.open !== open) writeWatcherDock(watchedId, { ...current, open });
  else if (focus) notify();
}

/** True exactly once per focus request, so a remounted dock never steals focus. */
export function consumeWatcherDockFocus(watchedId: string): boolean {
  const token = focusTokens.get(watchedId) ?? 0;
  if (token <= (consumedFocusTokens.get(watchedId) ?? 0)) return false;
  consumedFocusTokens.set(watchedId, token);
  return true;
}

export function watcherDockFocusToken(watchedId: string): number {
  return focusTokens.get(watchedId) ?? 0;
}

export function subscribeWatcherDock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWatcherDock(watchedId: string | null): WatcherDockController {
  const read = useCallback(() => watchedId ? readWatcherDock(watchedId) : CLOSED_RECORD, [watchedId]);
  const record = useSyncExternalStore(subscribeWatcherDock, read, read);
  const setOpen = useCallback((open: boolean, options?: { focusHeading?: boolean }) => {
    if (watchedId) setWatcherDockOpen(watchedId, open, options);
  }, [watchedId]);
  const markSeen = useCallback((at: string) => {
    const current = watchedId ? readWatcherDock(watchedId) : null;
    if (watchedId && current && (current.seenAt === null || current.seenAt < at)) {
      writeWatcherDock(watchedId, { ...current, seenAt: at });
    }
  }, [watchedId]);
  return useMemo(() => ({ ...record, setOpen, markSeen }), [markSeen, record, setOpen]);
}

/** Test seam: forget cached records so storage is read again. */
export function resetWatcherDockStore(): void {
  records.clear();
  focusTokens.clear();
  consumedFocusTokens.clear();
}
