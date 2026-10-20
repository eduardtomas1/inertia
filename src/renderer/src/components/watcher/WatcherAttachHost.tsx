import { useRef } from "react";

import type { AppSettings, AppSnapshot, ProviderId, ServerEvent } from "@shared/contracts";
import type { WatcherLinkView } from "@shared/watcher";
import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import type { WatcherAttachTarget } from "../../hooks/useWatcherSurface";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import { DialogPresence } from "../DialogPresence";
import { loadWatcherAttachDialog } from "./watcherLoaders";

/** Eager host for the lazy attach dialog; renders nothing until it opens. */
export function WatcherAttachHost({
  target,
  snapshot,
  settings,
  request,
  onClose,
  onAttached,
  onOpenProviderSetup,
  onOpenBackendSetup,
}: {
  target: WatcherAttachTarget | null;
  snapshot: AppSnapshot | null;
  settings: AppSettings;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  onClose: () => void;
  onAttached: (link: WatcherLinkView) => void;
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onOpenBackendSetup: (profileId: string) => void;
}): React.JSX.Element | null {
  const lastTarget = useRef<WatcherAttachTarget | null>(null);
  if (target) lastTarget.current = target;
  const WatcherAttachDialog = useLoadedSurface(loadWatcherAttachDialog, target !== null);
  const shown = lastTarget.current;
  if (!snapshot || !WatcherAttachDialog || !shown) return null;
  return (
    <DialogPresence open={target !== null}>
      <WatcherAttachDialog
        key={shown.watchedId}
        snapshot={snapshot}
        settings={settings}
        watchedConversationId={shown.watchedId}
        returnFocusTo={shown.returnFocusTo}
        request={request}
        onClose={onClose}
        onAttached={onAttached}
        onOpenProviderSetup={onOpenProviderSetup}
        onOpenBackendSetup={onOpenBackendSetup}
      />
    </DialogPresence>
  );
}
