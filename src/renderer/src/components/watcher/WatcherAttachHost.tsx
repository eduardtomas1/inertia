import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import type { WatcherAttachHostProps } from "./WatcherAttachDialog";
import { loadWatcherAttachDialog } from "./watcherLoaders";

/** Eager host for the lazy attach dialog; renders nothing until it opens. */
export function WatcherAttachHost(props: WatcherAttachHostProps): React.JSX.Element | null {
  const WatcherAttachPresence = useLoadedSurface(loadWatcherAttachDialog, props.target !== null);
  return WatcherAttachPresence ? <WatcherAttachPresence {...props} /> : null;
}
