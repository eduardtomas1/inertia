import { useEffect, useRef, useState } from "react";

import { useWatcherDock } from "../../hooks/useWatcherDock";
import { watcherAgentLabel } from "@shared/watcher-agent-label";
import { watcherPresetName } from "../../utils/watcherLinks";
import { useWatcherSurface, watcherDockId } from "./watcherContext";
import "./WatchedByChip.css";

/**
 * Announces a new finding while the dock (and its own live region) is out of
 * sight. Alternates a trailing period so a second finding is read again.
 */
function useCollapsedFindingAnnouncement(latestFindingAt: string | null, dockShown: boolean): string {
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef(latestFindingAt);
  useEffect(() => {
    const prior = previous.current;
    previous.current = latestFindingAt;
    if (dockShown) {
      setAnnouncement("");
      return;
    }
    if (latestFindingAt !== null && latestFindingAt !== prior && (prior === null || latestFindingAt > prior)) {
      setAnnouncement((current) => current === "New finding" ? "New finding." : "New finding");
    }
  }, [dockShown, latestFindingAt]);
  return announcement;
}

/**
 * Shows that this chat has a watcher and toggles its dock. Eager and tiny:
 * the dock itself loads only when it first opens.
 */
export function WatchedByChip({ conversationId }: { conversationId: string }): React.JSX.Element | null {
  const surface = useWatcherSurface();
  const link = surface?.links.byWatched.get(conversationId) ?? null;
  const dock = useWatcherDock(link ? conversationId : null);
  const detached = surface?.surface === "detached";
  const latestFindingAt = link?.latestFindingAt ?? null;
  const announcement = useCollapsedFindingAnnouncement(latestFindingAt, dock.open && !detached);
  if (!surface || !link) return null;
  const label = `Watched by ${watcherAgentLabel(
    surface.conversations.find(({ id }) => id === link.watcherConversationId),
    surface.providerLabels,
  )} · ${watcherPresetName(link.preset)}`;
  const unseen = latestFindingAt !== null && (dock.seenAt === null || latestFindingAt > dock.seenAt);
  return (
    <>
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
        <span className="watched-by-chip-label">{label}</span>
        {link.status === "paused" && <span className="watched-by-chip-note"> · Paused</span>}
        {unseen && <span className="watched-by-chip-new"> · new finding</span>}
        {detached && <span className="watched-by-chip-note"> · Return to main window</span>}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">{announcement}</span>
    </>
  );
}
