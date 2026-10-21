import { useMemo } from "react";

import type { AppSnapshot } from "@shared/contracts";
import { indexWatcherLinks, type WatcherLinkIndex } from "../utils/watcherLinks";

export function useWatcherLinks(snapshot: Pick<AppSnapshot, "watchers"> | null): WatcherLinkIndex {
  const watchers = snapshot?.watchers;
  return useMemo(() => indexWatcherLinks(watchers), [watchers]);
}
