import { useCallback, useMemo, useSyncExternalStore } from "react";

import { layoutStorage } from "../utils/layoutStorage";

/**
 * Per watched chat: whether its dock is collapsed and the newest finding the
 * user has already seen. The chip in the composer and the dock beside the
 * chat read the same record, so both always agree.
 */
export interface WatcherDockRecord {
  open: boolean;
  seenAt: string | null;
}

export interface WatcherDockController extends WatcherDockRecord {
  setOpen: (open: boolean, options?: { focusHeading?: boolean }) => void;
  markSeen: (at: string) => void;
}

const DEFAULT_RECORD: WatcherDockRecord = Object.freeze({ open: true, seenAt: null });
const records = new Map<string, WatcherDockRecord>();
const listeners = new Set<() => void>();
const focusTokens = new Map<string, number>();
const consumedFocusTokens = new Map<string, number>();
const focusListeners = new Set<() => void>();

export function watcherDockStorageKey(watchedId: string): string {
  return `inertia:layout:watcher-dock:${encodeURIComponent(watchedId)}:v1`;
}

function parseRecord(value: string | null): WatcherDockRecord {
  if (value === null) return DEFAULT_RECORD;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_RECORD;
    const { open, seenAt } = parsed as Record<string, unknown>;
    return {
      open: open !== false,
      seenAt: typeof seenAt === "string" && seenAt.length <= 64 ? seenAt : null,
    };
  } catch {
    return DEFAULT_RECORD;
  }
}

export function readWatcherDock(watchedId: string): WatcherDockRecord {
  let record = records.get(watchedId);
  if (!record) {
    record = parseRecord(layoutStorage.getItem(watcherDockStorageKey(watchedId)));
    records.set(watchedId, record);
  }
  return record;
}

function writeWatcherDock(watchedId: string, next: WatcherDockRecord): void {
  const current = readWatcherDock(watchedId);
  if (current.open === next.open && current.seenAt === next.seenAt) return;
  records.set(watchedId, next);
  if (next.open && next.seenAt === null) {
    layoutStorage.removeItem(watcherDockStorageKey(watchedId));
  } else {
    layoutStorage.setItem(watcherDockStorageKey(watchedId), JSON.stringify(next));
  }
  for (const listener of listeners) listener();
}

export function setWatcherDockOpen(
  watchedId: string,
  open: boolean,
  options: { focusHeading?: boolean } = {},
): void {
  const current = readWatcherDock(watchedId);
  writeWatcherDock(watchedId, { ...current, open });
  if (open && options.focusHeading) requestWatcherDockFocus(watchedId);
}

/** Asks the dock to move focus to its heading once it is (or stays) open. */
export function requestWatcherDockFocus(watchedId: string): void {
  focusTokens.set(watchedId, (focusTokens.get(watchedId) ?? 0) + 1);
  for (const listener of focusListeners) listener();
}

function subscribeFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}

/** True exactly once per request, so a remounted dock never steals focus. */
export function consumeWatcherDockFocus(watchedId: string, token: number): boolean {
  if (token <= (consumedFocusTokens.get(watchedId) ?? 0)) return false;
  consumedFocusTokens.set(watchedId, token);
  return true;
}

/** Changes whenever a focus request arrives for this watched chat. */
export function useWatcherDockFocusToken(watchedId: string): number {
  const read = useCallback(() => focusTokens.get(watchedId) ?? 0, [watchedId]);
  return useSyncExternalStore(subscribeFocus, read, read);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWatcherDock(watchedId: string | null): WatcherDockController {
  const read = useCallback(
    () => watchedId ? readWatcherDock(watchedId) : DEFAULT_RECORD,
    [watchedId],
  );
  const record = useSyncExternalStore(subscribe, read, read);
  const setOpen = useCallback((open: boolean, options?: { focusHeading?: boolean }) => {
    if (watchedId) setWatcherDockOpen(watchedId, open, options);
  }, [watchedId]);
  const markSeen = useCallback((at: string) => {
    if (!watchedId) return;
    const current = readWatcherDock(watchedId);
    if (current.seenAt !== null && current.seenAt >= at) return;
    writeWatcherDock(watchedId, { ...current, seenAt: at });
  }, [watchedId]);
  return useMemo(
    () => ({ open: record.open, seenAt: record.seenAt, setOpen, markSeen }),
    [markSeen, record.open, record.seenAt, setOpen],
  );
}

/** Test seam: forget cached records so storage is read again. */
export function resetWatcherDockStore(): void {
  records.clear();
  focusTokens.clear();
  consumedFocusTokens.clear();
  for (const listener of listeners) listener();
}
