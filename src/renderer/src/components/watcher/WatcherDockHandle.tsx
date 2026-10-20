import { useEffect, useRef, useState } from "react";

import type { WatcherLinkView } from "@shared/watcher";
import type { WatcherDockController } from "../../hooks/useWatcherDock";
import { watcherUnseenText } from "../../utils/watcherLinks";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import { TooltipButton } from "../TooltipButton";
import { watcherDockId } from "./watcherContext";
import "./WatcherDockHandle.css";

/**
 * Announces a new finding while the dock is collapsed. Alternates a trailing
 * period so a second finding is read again.
 */
function useCollapsedFindingAnnouncement(latestFindingAt: string | null): string {
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef(latestFindingAt);
  useEffect(() => {
    const prior = previous.current;
    previous.current = latestFindingAt;
    if (latestFindingAt !== null && latestFindingAt !== prior && (prior === null || latestFindingAt > prior)) {
      setAnnouncement((current) => current === "New finding" ? "New finding." : "New finding");
    }
  }, [latestFindingAt]);
  return announcement;
}

export function watcherHandleFor(watchedId: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>("[data-watcher-handle]")]
    .find((candidate) => candidate.dataset.watcherHandle === watchedId) ?? null;
}

/** The collapsed dock: a slim edge in the dock's place that opens it again. */
export function WatcherDockHandle({ watchedId, link, providerId, dock, controlsDock }: {
  watchedId: string;
  link: WatcherLinkView;
  providerId: string | undefined;
  dock: WatcherDockController;
  controlsDock: boolean;
}): React.JSX.Element {
  const announcement = useCollapsedFindingAnnouncement(link.latestFindingAt ?? null);
  const unseen = watcherUnseenText(link, dock);
  return (
    <div className="watcher-dock-handle">
      <TooltipButton
        tooltip="Open watcher"
        describeTooltip={false}
        aria-label={unseen ? `Open watcher, ${unseen}` : "Open watcher"}
        aria-expanded={false}
        aria-controls={controlsDock ? watcherDockId(watchedId) : undefined}
        className="watcher-dock-handle-button"
        data-watcher-handle={watchedId}
        onClick={() => dock.setOpen(true, { focusHeading: true })}
      >
        <ProviderBrandIcon providerId={providerId} decorative size={16} />
        {unseen && <span className="watcher-dock-handle-new" aria-hidden="true">{unseen}</span>}
      </TooltipButton>
      <span className="visually-hidden" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}
