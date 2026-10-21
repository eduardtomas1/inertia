import type { WatcherLinkView } from "@shared/watcher";
import type { SidebarThreadView } from "./sidebarModel";

/*
 * Work-tab nesting for watchers. Kept out of the eager sidebar model: only
 * the lazy Sidebar chunk needs it.
 */

interface NestedWatcherThreads {
  /** Top-level threads: every attached watcher whose chat is listed is removed. */
  threads: SidebarThreadView[];
  /** The watcher row to show directly under each watched chat. */
  watchersByParent: ReadonlyMap<string, SidebarThreadView>;
  /**
   * Attached watchers listed as ordinary rows (their chat is not listed, or
   * they are finishing a check while their chat sits in Done). They keep a
   * watcher marker, keyed by the watcher's chat.
   */
  topLevelWatchers: ReadonlyMap<string, WatcherLinkView>;
}

const NO_WATCHERS: ReadonlyMap<string, WatcherLinkView> = new Map();

/**
 * Nests attached watchers under the chat they watch. A detached watcher stays
 * an ordinary thread. An attached watcher stays top-level, marked as a
 * watcher, when its chat is not listed (archived, or filtered out by search
 * or scope), and while it runs a check under a chat that is already settled:
 * a collapsed Done section must not hide work in progress.
 */
export function nestWatcherThreads(
  views: readonly SidebarThreadView[],
  links: readonly WatcherLinkView[] | undefined,
): NestedWatcherThreads {
  if (!links?.some(({ status }) => status !== "detached")) {
    return { threads: [...views], watchersByParent: new Map(), topLevelWatchers: NO_WATCHERS };
  }
  const byId = new Map(views.map((view) => [view.conversation.id, view]));
  const parentByWatcher = new Map<string, string>();
  const topLevelWatchers = new Map<string, WatcherLinkView>();
  for (const link of links) {
    const watcher = byId.get(link.watcherConversationId);
    if (link.status === "detached" || !watcher) continue;
    const parent = link.watchedConversationId ? byId.get(link.watchedConversationId) : undefined;
    const workingUnderDone = parent?.settled === true && watcher.status === "working";
    if (!parent || workingUnderDone) {
      topLevelWatchers.set(link.watcherConversationId, link);
      continue;
    }
    parentByWatcher.set(link.watcherConversationId, parent.conversation.id);
  }
  const watchersByParent = new Map<string, SidebarThreadView>();
  const threads: SidebarThreadView[] = [];
  for (const view of views) {
    const parent = parentByWatcher.get(view.conversation.id);
    if (parent && !parentByWatcher.has(parent)) watchersByParent.set(parent, view);
    else threads.push(view);
  }
  return { threads, watchersByParent, topLevelWatchers };
}
