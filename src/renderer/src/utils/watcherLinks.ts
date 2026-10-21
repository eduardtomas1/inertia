import type { WatcherLinkView, WatcherPreset } from "@shared/watcher";
import { INTERFACE_LOCALE } from "../lib/locale";

export const MAX_ACTIVE_WATCHERS = 8;

export interface WatcherLinkIndex {
  byWatched: ReadonlyMap<string, WatcherLinkView>;
  byWatcher: ReadonlyMap<string, WatcherLinkView>;
  activeCount: number;
}

const EMPTY_INDEX: WatcherLinkIndex = Object.freeze({
  byWatched: new Map<string, WatcherLinkView>(),
  byWatcher: new Map<string, WatcherLinkView>(),
  activeCount: 0,
});

export function indexWatcherLinks(
  links: readonly WatcherLinkView[] | undefined,
): WatcherLinkIndex {
  if (!links || links.length === 0) return EMPTY_INDEX;
  const byWatched = new Map<string, WatcherLinkView>();
  const byWatcher = new Map<string, WatcherLinkView>();
  for (const link of links) {
    if (link.status === "detached") continue;
    byWatcher.set(link.watcherConversationId, link);
    if (link.watchedConversationId) byWatched.set(link.watchedConversationId, link);
  }
  return { byWatched, byWatcher, activeCount: byWatcher.size };
}

export const WATCHER_PRESET_NAMES: Readonly<Record<WatcherPreset, string>> = {
  reviewer: "Reviewer",
  "scope-guard": "Scope guard",
  explainer: "Explainer",
};

export function watcherPresetName(preset: WatcherPreset): string {
  return WATCHER_PRESET_NAMES[preset] ?? preset;
}

export function watcherRowName(preset: WatcherPreset): string {
  return `Watcher · ${watcherPresetName(preset)}`;
}

export const WATCHER_NOTE_TITLE = "Note from watcher";

export function watcherEventsText(count: number): string {
  return `${count.toLocaleString(INTERFACE_LOCALE)} ${count === 1 ? "event" : "events"}`;
}

export function watcherCheckTitle(wake: { sequence: number; eventsCovered: number }): string {
  return `Check ${wake.sequence} · ${watcherEventsText(wake.eventsCovered)}`;
}

export function watcherUnseenText(
  link: WatcherLinkView,
  seen: { seenAt: string | null; seenFindings: number | null },
): string | null {
  const latest = link.latestFindingAt;
  if (latest === null || (seen.seenAt !== null && latest <= seen.seenAt)) return null;
  const count = seen.seenAt !== null && seen.seenFindings === null
    ? null
    : link.counters.findingsTotal - (seen.seenFindings ?? 0);
  return count !== null && count > 0 ? `${count.toLocaleString(INTERFACE_LOCALE)} new` : "new";
}
