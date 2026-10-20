import { useRef } from "react";

import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import { useWatcherDock } from "../../hooks/useWatcherDock";
import { useWatcherSurface } from "./watcherContext";
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
  const WatcherDock = useLoadedSurface(loadWatcherDock, activated);
  if (!surface || !link || !watchedId || !activated || !WatcherDock) return null;
  return <WatcherDock key={watchedId} watchedId={watchedId} link={link} surface={surface} dock={dock} />;
}
