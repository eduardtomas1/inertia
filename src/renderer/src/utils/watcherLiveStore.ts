import { useCallback, useSyncExternalStore } from "react";

import type { RuntimeMutationEvent } from "@shared/contracts";

export type WatcherLiveEvent = Extract<RuntimeMutationEvent, { type: "watcher.live" }>;

/**
 * Ephemeral phase ticks of running watcher checks, one per link (at most
 * eight active). They are never folded into the app snapshot, so a phase
 * change re-renders only the dock bar that subscribes to it.
 */
const latestByLink = new Map<string, WatcherLiveEvent>();
const listeners = new Set<() => void>();

export function publishWatcherLive(event: WatcherLiveEvent): void {
  latestByLink.set(event.linkId, event);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWatcherLive(linkId: string | null): WatcherLiveEvent | null {
  const read = useCallback(() => (linkId ? latestByLink.get(linkId) : undefined) ?? null, [linkId]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Test seam: drops every cached phase. */
export function resetWatcherLiveStore(): void {
  latestByLink.clear();
  for (const listener of listeners) listener();
}
