import type { WatcherLinkView } from "@shared/watcher";
import type { SidebarThreadView } from "./sidebarModel";

interface NestedWatcherThreads {
  threads: SidebarThreadView[];
  watchersByParent: ReadonlyMap<string, SidebarThreadView>;
  topLevelWatchers: ReadonlyMap<string, WatcherLinkView>;
}

const NO_WATCHERS: ReadonlyMap<string, WatcherLinkView> = new Map();

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
