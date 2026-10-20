import { useRef } from "react";

import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import { useWatcherDock } from "../../hooks/useWatcherDock";
import type { WatcherDockProps } from "./WatcherDock";
import { useWatcherSurface } from "./watcherContext";
import { WatcherErrorBoundary } from "./WatcherErrorBoundary";
import { loadWatcherDock } from "./watcherLoaders";

/**
 * Eager placeholder beside a chat. It renders nothing until the chat has a
 * watcher and its dock has been opened once, then keeps the lazy dock mounted
 * so collapsing and reopening animate instead of reloading.
 */
export function WatcherDockHost({ watchedId }: { watchedId: string | null }): React.JSX.Element | null {
  const surface = useWatcherSurface();
  const link = watchedId && surface?.surface === "main"
    ? surface.links.byWatched.get(watchedId) ?? null
    : null;
  const dock = useWatcherDock(link ? watchedId : null);
  const activatedRef = useRef<string | null>(null);
  if (link && dock.open) activatedRef.current = watchedId;
  const activated = link !== null && activatedRef.current === watchedId;
  if (!surface || !link || !watchedId || !activated) return null;
  return (
    <WatcherErrorBoundary key={watchedId} fallback={null} resetKey={dock.motion}>
      <LoadedWatcherDock watchedId={watchedId} link={link} surface={surface} dock={dock} />
    </WatcherErrorBoundary>
  );
}

function LoadedWatcherDock(props: WatcherDockProps): React.JSX.Element | null {
  const WatcherDock = useLoadedSurface(loadWatcherDock, true);
  return WatcherDock ? <WatcherDock {...props} /> : null;
}
