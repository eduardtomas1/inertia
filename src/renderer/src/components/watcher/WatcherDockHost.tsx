import { useCallback, useRef, useSyncExternalStore } from "react";

import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import { subscribeWatcherDock, useWatcherDock, watcherDockFocusToken } from "../../hooks/useWatcherDock";
import type { WatcherDockProps } from "./WatcherDock";
import { WatcherDockHandle } from "./WatcherDockHandle";
import { useWatcherSurface } from "./watcherContext";
import { WatcherErrorBoundary } from "./WatcherErrorBoundary";
import { loadWatcherDock } from "./watcherLoaders";

export function WatcherDockHost({ watchedId }: { watchedId: string | null }): React.JSX.Element | null {
  const surface = useWatcherSurface();
  const link = watchedId && surface?.surface === "main"
    ? surface.links.byWatched.get(watchedId) ?? null
    : null;
  const dock = useWatcherDock(link ? watchedId : null);
  const readFocusToken = useCallback(() => watchedId ? watcherDockFocusToken(watchedId) : 0, [watchedId]);
  const focusToken = useSyncExternalStore(subscribeWatcherDock, readFocusToken, readFocusToken);
  const activatedRef = useRef<string | null>(null);
  if (link && dock.open) activatedRef.current = watchedId;
  const activated = link !== null && activatedRef.current === watchedId;
  if (!surface || !link || !watchedId) return null;
  const watcher = surface.conversations.find(({ id }) => id === link.watcherConversationId);
  const handle = (controlsDock: boolean): React.JSX.Element => (
    <WatcherDockHandle
      watchedId={watchedId}
      link={link}
      providerId={watcher?.providerId}
      dock={dock}
      controlsDock={controlsDock}
    />
  );
  return (
    <>
      {!dock.open && handle(activated)}
      {activated && (
        <WatcherErrorBoundary
          key={watchedId}
          fallback={dock.open ? handle(false) : null}
          resetKey={`${dock.motion}:${focusToken}`}
        >
          <LoadedWatcherDock watchedId={watchedId} link={link} surface={surface} dock={dock} />
        </WatcherErrorBoundary>
      )}
    </>
  );
}

function LoadedWatcherDock(props: WatcherDockProps): React.JSX.Element | null {
  const WatcherDock = useLoadedSurface(loadWatcherDock, true);
  return WatcherDock ? <WatcherDock {...props} /> : null;
}
