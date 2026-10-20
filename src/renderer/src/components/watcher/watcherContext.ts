import { createContext, useContext } from "react";

import type {
  ConversationShell,
  ModelBackendProfileView,
  Project,
  ServerEvent,
} from "@shared/contracts";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import type { WatcherLinkIndex } from "../../utils/watcherLinks";

/**
 * Everything the watcher surfaces read from the shell. It is provided once per
 * window, so panes, menus, the palette and the composer need no new props.
 * No member opens a conversation detail subscription; only `openWatcherChat`
 * does, and only because the user asked for the watcher's own chat.
 */
export interface WatcherSurfaceModel {
  surface: "main" | "detached";
  links: WatcherLinkIndex;
  conversations: readonly ConversationShell[];
  projects: readonly Project[];
  backendProfiles: readonly ModelBackendProfileView[];
  /** Provider display names: configured identity labels over provider labels. */
  providerLabels: ProviderIdentityLabels;
  primaryConversationId: string | null;
  online: boolean;
  request: ((command: CommandWithoutId) => Promise<ServerEvent>) | null;
  openAttachDialog: ((watchedId: string, returnFocusTo?: HTMLElement | null) => void) | null;
  showWatcher: (watchedId: string) => void;
  openWatcherChat: ((watcherConversationId: string) => void) | null;
  openInMainWindow: (() => void) | null;
}

export const WatcherContext = createContext<WatcherSurfaceModel | null>(null);
WatcherContext.displayName = "WatcherContext";

export function useWatcherSurface(): WatcherSurfaceModel | null {
  return useContext(WatcherContext);
}

/** True when the chat is an attached watcher, whose run settings are locked. */
export function useWatcherRunLock(conversationId: string | null | undefined): boolean {
  const surface = useContext(WatcherContext);
  return Boolean(conversationId && surface?.links.byWatcher.has(conversationId));
}

export const WATCHER_RUN_LOCK_LABEL = "Read-only watcher · Plan · Supervised";

export function watcherDockId(watchedId: string): string {
  return `watcher-dock-${watchedId}`;
}

export function watcherDockHeadingId(watchedId: string): string {
  return `watcher-dock-heading-${watchedId}`;
}
