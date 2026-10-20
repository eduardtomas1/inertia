import { useId, type CSSProperties } from "react";

import type { WatcherDeliveryMode, WatcherFeedItem } from "@shared/watcher";
import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import { createSurfaceLoader } from "../../utils/surfaceLoader";
import { watcherClockTime, watcherDeliveryText } from "../../utils/watcherCopy";
import { WatcherDeliverButton } from "./WatcherDeliverButton";

// The existing deferred Markdown renderer; the card shows plain text until
// it arrives, so a finding is readable even if that chunk is still loading.
const loadFindingMarkdown = createSurfaceLoader(async () => ({
  default: (await import("../ResponseMarkdown")).ResponseMarkdown,
}));

function findingStatus(
  delivery: WatcherFeedItem["delivery"],
  { sending, failure, watchedRunning }: { sending: boolean; failure: string | null; watchedRunning: boolean },
): string {
  if (sending) return "Sending…";
  if (failure) return `Not sent · ${failure}`;
  if (!delivery) return "";
  const text = watcherDeliveryText(delivery, watchedRunning);
  return delivery.state === "failed" && delivery.detail ? `${text} · ${delivery.detail}` : text;
}

export interface WatcherFindingCardProps {
  item: WatcherFeedItem;
  motionIndex: number;
  projectRoot: string;
  projectId: string;
  watchedConversationId: string;
  watchedRunning: boolean;
  steerable: boolean;
  sending: boolean;
  failure: string | null;
  online: boolean;
  onDeliver: (item: WatcherFeedItem, mode: WatcherDeliveryMode) => void;
  onDismiss: (item: WatcherFeedItem) => void;
  statusRef: (wakeId: string, node: HTMLParagraphElement | null) => void;
  cardRef: (wakeId: string, node: HTMLElement | null) => void;
}

export function WatcherFindingCard({
  item,
  motionIndex,
  projectRoot,
  projectId,
  watchedConversationId,
  watchedRunning,
  steerable,
  sending,
  failure,
  online,
  onDeliver,
  onDismiss,
  statusRef,
  cardRef,
}: WatcherFindingCardProps): React.JSX.Element {
  const titleId = useId();
  const Markdown = useLoadedSurface(loadFindingMarkdown, true);
  const delivery = item.delivery;
  const deliverable = delivery === null || delivery.state === "failed";
  const status = findingStatus(delivery, { sending, failure, watchedRunning });
  const detail = delivery && delivery.state !== "failed" ? delivery.detail : null;
  const finding = item.finding ?? "";
  return (
    <article
      ref={(node) => cardRef(item.wakeId, node)}
      className="watcher-finding"
      aria-labelledby={titleId}
      data-wake-id={item.wakeId}
      data-delivery={delivery?.state ?? (sending ? "sending" : "none")}
      tabIndex={-1}
      style={{ "--motion-index": Math.min(motionIndex, 5) } as CSSProperties}
    >
      <header className="watcher-finding-header">
        <h3 id={titleId}>Finding</h3>
        <span className="watcher-finding-meta">
          Check {item.sequence}
          {item.settledAt ? ` · ${watcherClockTime(item.settledAt)}` : ""}
        </span>
      </header>
      <div className="watcher-finding-body">
        {Markdown ? (
          <Markdown
            content={finding}
            projectRoot={projectRoot}
            projectId={projectId}
            conversationId={watchedConversationId}
            defaultCodeWrap
          />
        ) : <p className="watcher-finding-plain">{finding}</p>}
      </div>
      {deliverable && (
        <div className="watcher-finding-actions">
          <WatcherDeliverButton
            disabled={sending || !online}
            steerable={steerable}
            onDeliver={(mode) => onDeliver(item, mode)}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={sending || !online}
            onClick={() => onDismiss(item)}
          >
            Dismiss
          </button>
        </div>
      )}
      <p
        ref={(node) => statusRef(item.wakeId, node)}
        className="watcher-finding-status"
        role="status"
        aria-live="polite"
        tabIndex={-1}
        data-state={delivery?.state ?? (sending ? "sending" : "none")}
      >
        {status}
        {detail && <small>{detail}</small>}
      </p>
    </article>
  );
}
