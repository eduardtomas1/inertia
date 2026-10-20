import { useCallback, useMemo, useState } from "react";

import type { AppSnapshot, Conversation, ServerEvent } from "@shared/contracts";
import type { WatcherLinkView } from "@shared/watcher";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { WatcherSurfaceModel } from "../components/watcher/watcherContext";
import { prefetchWatcherAttachDialog } from "../components/watcher/watcherLoaders";
import { setWatcherDockOpen } from "./useWatcherDock";
import { useStableActions } from "./useStableController";
import { useWatcherLinks } from "./useWatcherLinks";

export interface WatcherAttachTarget {
  watchedId: string;
  returnFocusTo: HTMLElement | null;
}

export interface WatcherSurfaceController {
  surface: WatcherSurfaceModel;
  attach: {
    target: WatcherAttachTarget | null;
    close: () => void;
    attached: (link: WatcherLinkView) => void;
  };
}

/**
 * Builds the window's watcher model from the shell snapshot. Main windows can
 * attach, show and open watchers; a detached chat window only shows the chip
 * and sends the user back to the main window.
 */
export function useWatcherSurfaceController({
  snapshot,
  surface: kind,
  online,
  request,
  primaryConversationId,
  visibleConversationIds,
  selectConversation,
  openConversationInSplit,
  openInMainWindow,
}: {
  snapshot: AppSnapshot | null;
  surface: WatcherSurfaceModel["surface"];
  online: boolean;
  request: ((command: CommandWithoutId) => Promise<ServerEvent>) | null;
  primaryConversationId: string | null;
  visibleConversationIds?: ReadonlySet<string>;
  selectConversation?: (conversation: Conversation) => void;
  openConversationInSplit?: (conversation: Conversation) => void;
  openInMainWindow?: () => void;
}): WatcherSurfaceController {
  const links = useWatcherLinks(snapshot);
  const conversationsList = snapshot?.conversations;
  const projectsList = snapshot?.projects;
  const conversations = useMemo(
    () => new Map((conversationsList ?? []).map((conversation) => [conversation.id, conversation])),
    [conversationsList],
  );
  const projects = useMemo(
    () => new Map((projectsList ?? []).map((project) => [project.id, project])),
    [projectsList],
  );
  const [target, setTarget] = useState<WatcherAttachTarget | null>(null);
  const main = kind === "main";
  const actions = useStableActions({
    reveal: (watchedId: string): void => {
      const watched = conversations.get(watchedId);
      if (
        watched
        && watchedId !== primaryConversationId
        && !visibleConversationIds?.has(watchedId)
      ) selectConversation?.(watched);
      setWatcherDockOpen(watchedId, true, { focusHeading: true });
    },
    openAttachDialog: (watchedId: string, returnFocusTo: HTMLElement | null = null): void => {
      prefetchWatcherAttachDialog();
      // Without an explicit trigger the dialog restores focus to whatever
      // held it when the dialog mounted (a closing palette has restored it).
      setTarget({ watchedId, returnFocusTo });
    },
    openWatcherChat: (watcherConversationId: string): void => {
      const watcher = conversations.get(watcherConversationId);
      if (watcher) openConversationInSplit?.(watcher);
    },
    openInMainWindow: (): void => openInMainWindow?.(),
  });
  const close = useCallback(() => setTarget(null), []);
  const { reveal } = actions;
  const attached = useCallback((link: WatcherLinkView) => {
    setTarget(null);
    if (link.watchedConversationId) reveal(link.watchedConversationId);
  }, [reveal]);
  const canOpenWatcherChat = main && Boolean(openConversationInSplit);
  const canOpenMainWindow = Boolean(openInMainWindow);
  const providerIdentityLabels = snapshot?.settings.providerIdentityLabels;
  const backendProfiles = snapshot?.backendProfiles;
  const surface = useMemo<WatcherSurfaceModel>(() => ({
    surface: kind,
    links,
    conversations,
    projects,
    backendProfiles: backendProfiles ?? [],
    providerIdentityLabels: providerIdentityLabels ?? {},
    primaryConversationId,
    online,
    request,
    openAttachDialog: main ? actions.openAttachDialog : null,
    showWatcher: actions.reveal,
    openWatcherChat: canOpenWatcherChat ? actions.openWatcherChat : null,
    openInMainWindow: canOpenMainWindow ? actions.openInMainWindow : null,
  }), [
    actions,
    backendProfiles,
    canOpenMainWindow,
    canOpenWatcherChat,
    conversations,
    kind,
    links,
    main,
    online,
    primaryConversationId,
    projects,
    providerIdentityLabels,
    request,
  ]);
  return useMemo(() => ({ surface, attach: { target, close, attached } }), [attached, close, surface, target]);
}
