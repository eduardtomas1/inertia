import { useCallback, useMemo, useRef, useState } from "react";

import type { AppSnapshot, Conversation, ServerEvent } from "@shared/contracts";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import type { WatcherLinkView } from "@shared/watcher";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { WatcherSurfaceModel } from "../components/watcher/watcherContext";
import type { WatcherLinkIndex } from "../utils/watcherLinks";
import { cancelWatcherDockFocus, setWatcherDockOpen } from "./useWatcherDock";
import { useStableActions } from "./useStableController";
import { useWatcherLinks } from "./useWatcherLinks";

export interface WatcherAttachTarget {
  watchedId: string;
  returnFocusTo: HTMLElement | null;
}

interface WatcherSurfaceController {
  surface: WatcherSurfaceModel;
  attach: {
    target: WatcherAttachTarget | null;
    close: () => void;
    attached: (link: WatcherLinkView) => void;
  };
}

const NO_CONVERSATIONS: AppSnapshot["conversations"] = [];
const NO_PROJECTS: AppSnapshot["projects"] = [];
const NO_PROVIDERS: AppSnapshot["providers"] = [];
const NO_IDS: ReadonlySet<string> = new Set();

function useLinkedConversations(
  conversations: AppSnapshot["conversations"],
  links: WatcherLinkIndex,
): AppSnapshot["conversations"] {
  const previous = useRef<AppSnapshot["conversations"]>(NO_CONVERSATIONS);
  return useMemo(() => {
    if (links.byWatcher.size === 0) {
      previous.current = NO_CONVERSATIONS;
      return NO_CONVERSATIONS;
    }
    const linked = conversations.filter(({ id }) => links.byWatcher.has(id) || links.byWatched.has(id));
    const prior = previous.current;
    const same = prior.length === linked.length && linked.every((conversation, index) => prior[index] === conversation);
    if (same) return prior;
    previous.current = linked;
    return linked;
  }, [conversations, links]);
}

export function useWatcherSurfaceController({
  snapshot,
  surface: kind,
  online,
  request,
  primaryConversationId,
  visibleConversationIds,
  detachedConversationIds = NO_IDS,
  selectConversation,
  openConversationInSplit,
}: {
  snapshot: AppSnapshot | null;
  surface: WatcherSurfaceModel["surface"];
  online: boolean;
  request: ((command: CommandWithoutId) => Promise<ServerEvent>) | null;
  primaryConversationId: string | null;
  visibleConversationIds?: ReadonlySet<string>;
  detachedConversationIds?: ReadonlySet<string>;
  selectConversation?: (conversation: Conversation) => void;
  openConversationInSplit?: (conversation: Conversation) => void;
}): WatcherSurfaceController {
  const links = useWatcherLinks(snapshot);
  const conversations = snapshot?.conversations ?? NO_CONVERSATIONS;
  const linkedConversations = useLinkedConversations(conversations, links);
  const [target, setTarget] = useState<WatcherAttachTarget | null>(null);
  const main = kind === "main";
  const actions = useStableActions({
    reveal: (watchedId: string): void => {
      if (detachedConversationIds.has(watchedId)) {
        cancelWatcherDockFocus(watchedId);
        return;
      }
      const watched = conversations.find(({ id }) => id === watchedId);
      if (watched && watchedId !== primaryConversationId && !visibleConversationIds?.has(watchedId)) {
        selectConversation?.(watched);
      }
      setWatcherDockOpen(watchedId, true, { focusHeading: true });
    },
    openAttachDialog: (watchedId: string, returnFocusTo: HTMLElement | null = null): void => {
      setTarget({ watchedId, returnFocusTo });
    },
    openWatcherChat: (watcherConversationId: string): void => {
      const watcher = conversations.find(({ id }) => id === watcherConversationId);
      if (watcher) openConversationInSplit?.(watcher);
    },
  });
  const close = useCallback(() => setTarget(null), []);
  const { reveal } = actions;
  const attached = useCallback((link: WatcherLinkView) => {
    setTarget(null);
    if (link.watchedConversationId) reveal(link.watchedConversationId);
  }, [reveal]);
  const canOpenWatcherChat = main && Boolean(openConversationInSplit);
  const providers = snapshot?.providers;
  const identityLabels = snapshot?.settings.providerIdentityLabels;
  const providerLabels = useMemo<ProviderIdentityLabels>(() => ({
    ...Object.fromEntries((providers ?? []).map(({ id, label }) => [id, label])),
    ...identityLabels,
  }), [identityLabels, providers]);
  const projects = snapshot?.projects ?? NO_PROJECTS;
  const backendProfiles = snapshot?.backendProfiles;
  const providerInfo = providers ?? NO_PROVIDERS;
  const surface = useMemo<WatcherSurfaceModel>(() => ({
    surface: kind,
    links,
    conversations: linkedConversations,
    projects,
    providers: providerInfo,
    backendProfiles: backendProfiles ?? [],
    providerLabels,
    primaryConversationId,
    detachedConversationIds,
    online,
    request,
    openAttachDialog: main ? actions.openAttachDialog : null,
    showWatcher: actions.reveal,
    openWatcherChat: canOpenWatcherChat ? actions.openWatcherChat : null,
  }), [
    actions, backendProfiles, canOpenWatcherChat, detachedConversationIds, kind,
    linkedConversations, links, main, online, primaryConversationId, projects, providerInfo, providerLabels, request,
  ]);
  return useMemo(() => ({ surface, attach: { target, close, attached } }), [attached, close, surface, target]);
}
