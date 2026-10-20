import type { WatcherLinkView } from "@shared/watcher";
import type { SidebarThreadView } from "./sidebarModel";

/*
 * Work-tab nesting for watchers. Kept out of the eager sidebar model: only
 * the lazy Sidebar chunk needs it.
 */

export interface NestedWatcherThreads {
  /** Top-level threads: every attached watcher whose chat is listed is removed. */
  threads: SidebarThreadView[];
  /** The watcher row to show directly under each watched chat. */
  watchersByParent: ReadonlyMap<string, SidebarThreadView>;
}

/**
 * Nests attached watchers under the chat they watch. A detached watcher, or
 * one whose watched chat is not listed (filtered out by search or scope),
 * stays an ordinary top-level thread.
 */
export function nestWatcherThreads(
  views: readonly SidebarThreadView[],
  links: readonly WatcherLinkView[] | undefined,
): NestedWatcherThreads {
  if (!links?.some(({ status }) => status !== "detached")) {
    return { threads: [...views], watchersByParent: new Map() };
  }
  const listed = new Set(views.map(({ conversation }) => conversation.id));
  const parentByWatcher = new Map<string, string>();
  for (const link of links) {
    const parent = link.watchedConversationId;
    if (
      link.status === "detached"
      || !parent
      || !listed.has(parent)
      || !listed.has(link.watcherConversationId)
    ) continue;
    parentByWatcher.set(link.watcherConversationId, parent);
  }
  const watchersByParent = new Map<string, SidebarThreadView>();
  const threads: SidebarThreadView[] = [];
  for (const view of views) {
    const parent = parentByWatcher.get(view.conversation.id);
    if (parent && !parentByWatcher.has(parent)) watchersByParent.set(parent, view);
    else threads.push(view);
  }
  return { threads, watchersByParent };
}
