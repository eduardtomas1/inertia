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

/** "1 event" / "9 events"; eager because transcript estimates name checks. */
export function watcherEventsText(count: number): string {
  return `${count.toLocaleString(INTERFACE_LOCALE)} ${count === 1 ? "event" : "events"}`;
}
