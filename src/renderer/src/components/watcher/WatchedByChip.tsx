import { useWatcherDock } from "../../hooks/useWatcherDock";
import { watcherAgentLabel, watcherPresetName } from "../../utils/watcherLinks";
import { useWatcherSurface, watcherDockId } from "./watcherContext";
import "./WatchedByChip.css";

/**
 * Shows that this chat has a watcher and toggles its dock. Eager and tiny:
 * the dock itself loads only when it first opens.
 */
export function WatchedByChip({ conversationId }: { conversationId: string }): React.JSX.Element | null {
  const surface = useWatcherSurface();
  const link = surface?.links.byWatched.get(conversationId) ?? null;
  const dock = useWatcherDock(link ? conversationId : null);
  if (!surface || !link) return null;
  const label = `Watched by ${watcherAgentLabel(
    surface.conversations.get(link.watcherConversationId),
    surface.providerIdentityLabels,
  )} · ${watcherPresetName(link.preset)}`;
  const latest = link.latest;
  const unseen = latest?.outcome === "finding" && (dock.seenAt === null || latest.at > dock.seenAt);
  const detached = surface.surface === "detached";
  return (
    <button
      type="button"
      className="watched-by-chip"
      data-watcher-chip={conversationId}
      data-status={link.status}
      aria-expanded={detached ? undefined : dock.open}
      aria-controls={detached ? undefined : watcherDockId(conversationId)}
      onClick={() => {
        if (detached) surface.openInMainWindow?.();
        else dock.setOpen(!dock.open, { focusHeading: !dock.open });
      }}
    >
      <span className="watched-by-chip-mark" aria-hidden="true" />
      <span className="watched-by-chip-label">{label}</span>
      {link.status === "paused" && <span className="watched-by-chip-note">Paused</span>}
      {unseen && <span className="watched-by-chip-badge">New finding</span>}
      {detached && <span className="watched-by-chip-note">Open in main window</span>}
    </button>
  );
}
