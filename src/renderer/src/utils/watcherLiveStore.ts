import { useCallback, useSyncExternalStore } from "react";

import type { RuntimeMutationEvent } from "@shared/contracts";

export type WatcherLiveEvent = Extract<RuntimeMutationEvent, { type: "watcher.live" }>;

/**
 * Ephemeral phase ticks of running watcher checks. They are never folded into
 * the app snapshot, so a phase change re-renders only the subscribed dock bar.
 */
const latestByLink = new Map<string, WatcherLiveEvent>();
const listeners = new Map<string, Set<() => void>>();
const MAX_TRACKED_LINKS = 32;

function notify(linkId: string): void {
  for (const listener of listeners.get(linkId) ?? []) listener();
}

export function publishWatcherLive(event: WatcherLiveEvent): void {
  const current = latestByLink.get(event.linkId);
  if (
    current
    && current.turnId === event.turnId
    && current.phase === event.phase
    && current.label === event.label
  ) return;
  latestByLink.delete(event.linkId);
  latestByLink.set(event.linkId, event);
  if (latestByLink.size > MAX_TRACKED_LINKS) {
    const oldest = latestByLink.keys().next().value;
    if (oldest !== undefined && !listeners.has(oldest)) latestByLink.delete(oldest);
  }
  notify(event.linkId);
}

export function forgetWatcherLive(linkId: string): void {
  if (!latestByLink.delete(linkId)) return;
  notify(linkId);
}

export function readWatcherLive(linkId: string): WatcherLiveEvent | null {
  return latestByLink.get(linkId) ?? null;
}

export function subscribeWatcherLive(linkId: string, listener: () => void): () => void {
  let set = listeners.get(linkId);
  if (!set) {
    set = new Set();
    listeners.set(linkId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(linkId);
    current?.delete(listener);
    if (current?.size === 0) listeners.delete(linkId);
  };
}

export function useWatcherLive(linkId: string | null): WatcherLiveEvent | null {
  const subscribe = useCallback(
    (listener: () => void) => linkId ? subscribeWatcherLive(linkId, listener) : () => undefined,
    [linkId],
  );
  const read = useCallback(() => linkId ? readWatcherLive(linkId) : null, [linkId]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Test seam: drops every cached phase. */
export function resetWatcherLiveStore(): void {
  const linkIds = [...latestByLink.keys()];
  latestByLink.clear();
  for (const linkId of linkIds) notify(linkId);
}
