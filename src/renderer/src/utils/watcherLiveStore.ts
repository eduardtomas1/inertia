import { useCallback, useSyncExternalStore } from "react";

import type { RuntimeMutationEvent } from "@shared/contracts";
import type { WatcherLinkView } from "@shared/watcher";

export type WatcherLiveEvent = Extract<RuntimeMutationEvent, { type: "watcher.live" }>;

const latestByLink = new Map<string, WatcherLiveEvent>();
const listeners = new Set<() => void>();

export function publishWatcherLive(event: WatcherLiveEvent): void {
  latestByLink.set(event.linkId, event);
  for (const listener of listeners) listener();
}

export function clearWatcherLive(linkId: string): void {
  if (!latestByLink.delete(linkId)) return;
  for (const listener of listeners) listener();
}

export function retainWatcherLive(links: readonly WatcherLinkView[] | undefined): void {
  const waking = new Set((links ?? []).filter(({ status }) => status === "waking").map(({ id }) => id));
  let changed = false;
  for (const linkId of latestByLink.keys()) {
    if (waking.has(linkId)) continue;
    latestByLink.delete(linkId);
    changed = true;
  }
  if (changed) for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWatcherLive(linkId: string | null): WatcherLiveEvent | null {
  const read = useCallback(() => (linkId ? latestByLink.get(linkId) : undefined) ?? null, [linkId]);
  return useSyncExternalStore(subscribe, read, read);
}

export function resetWatcherLiveStore(): void {
  latestByLink.clear();
  for (const listener of listeners) listener();
}
