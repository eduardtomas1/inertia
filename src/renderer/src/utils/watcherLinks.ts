import type { WatcherLinkView, WatcherPreset } from "@shared/watcher";
import { INTERFACE_LOCALE } from "../lib/locale";

/**
 * Eager watcher lookups. This module deliberately imports only types from
 * `@shared/watcher`: its schema values stay in the deferred validator chunk
 * so the first-load routes do not grow with the feature.
 */
/**
 * Renderer copy of `MAX_ACTIVE_WATCHERS`: importing the value from
 * `@shared/watcher` would pull its zod schemas into the thread actions menu.
 * A unit test keeps the two equal.
 */
export const MAX_ACTIVE_WATCHERS = 8;

export interface WatcherLinkIndex {
  /** Attached (not detached) links, keyed by the chat they watch. */
  byWatched: ReadonlyMap<string, WatcherLinkView>;
  /** Attached (not detached) links, keyed by the watcher's own chat. */
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

/**
 * Renderer copy of the preset names. The record type keeps it exhaustive and
 * a unit test keeps it equal to `WATCHER_PRESET_LABELS`.
 */
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

/** "1 event" / "9 events"; eager because transcript estimates name checks. */
export function watcherEventsText(count: number): string {
  return `${count.toLocaleString(INTERFACE_LOCALE)} ${count === 1 ? "event" : "events"}`;
}

export function watcherCheckTitle(wake: { sequence: number; eventsCovered: number }): string {
  return `Check ${wake.sequence} · ${watcherEventsText(wake.eventsCovered)}`;
}

/** "2 new" for findings the user has not seen, "new" when the count is unknown. */
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
