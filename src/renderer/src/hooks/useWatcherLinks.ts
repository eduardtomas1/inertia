import { useMemo } from "react";

import type { AppSnapshot } from "@shared/contracts";
import { indexWatcherLinks, type WatcherLinkIndex } from "../utils/watcherLinks";

/** Memoized lookups of `snapshot.watchers` by watched and by watcher chat. */
export function useWatcherLinks(snapshot: Pick<AppSnapshot, "watchers"> | null): WatcherLinkIndex {
  const watchers = snapshot?.watchers;
  return useMemo(() => indexWatcherLinks(watchers), [watchers]);
}
