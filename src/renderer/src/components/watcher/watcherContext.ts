import { createContext, useContext } from "react";

import type {
  ConversationShell,
  ModelBackendProfileView,
  Project,
  ProviderInfo,
  ServerEvent,
} from "@shared/contracts";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import type { WatcherLinkIndex } from "../../utils/watcherLinks";

export interface WatcherSurfaceModel {
  surface: "main" | "detached";
  links: WatcherLinkIndex;
  conversations: readonly ConversationShell[];
  projects: readonly Project[];
  providers: readonly ProviderInfo[];
  backendProfiles: readonly ModelBackendProfileView[];
  providerLabels: ProviderIdentityLabels;
  primaryConversationId: string | null;
  detachedConversationIds: ReadonlySet<string>;
  online: boolean;
  request: ((command: CommandWithoutId) => Promise<ServerEvent>) | null;
  openAttachDialog: ((watchedId: string, returnFocusTo?: HTMLElement | null) => void) | null;
  showWatcher: (watchedId: string) => void;
  openWatcherChat: ((watcherConversationId: string) => void) | null;
}

export const WatcherContext = createContext<WatcherSurfaceModel | null>(null);
WatcherContext.displayName = "WatcherContext";

export function useWatcherSurface(): WatcherSurfaceModel | null {
  return useContext(WatcherContext);
}

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
