import { useId, type CSSProperties } from "react";

import type { WatcherDeliveryMode, WatcherFeedItem } from "@shared/watcher";
import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import { createSurfaceLoader } from "../../utils/surfaceLoader";
import { watcherClockTime, watcherDeliveryText } from "../../utils/watcherCopy";
import { WatcherDeliverButton } from "./WatcherDeliverButton";
import { WatcherErrorBoundary } from "./WatcherErrorBoundary";

// The existing deferred Markdown renderer; the card shows plain text until
// it arrives, so a finding is readable even if that chunk is still loading.
const loadFindingMarkdown = createSurfaceLoader(async () => ({
  default: (await import("../ResponseMarkdown")).ResponseMarkdown,
}));

/**
 * One status line. A local failure shows only while the runtime still has no
 * delivery (or a failed one): once the feed says queued or sent, that wins.
 */
function findingStatus(
  delivery: WatcherFeedItem["delivery"],
  { sending, failure, watchedRunning }: { sending: boolean; failure: string | null; watchedRunning: boolean },
): string {
  if (sending) return "Sending…";
  if (failure && (delivery === null || delivery.state === "failed")) return `Not sent · ${failure}`;
  if (!delivery) return "";
  return watcherDeliveryText(delivery, watchedRunning);
}

export interface WatcherFindingCardProps {
  item: WatcherFeedItem;
  motionIndex: number;
  /** True until this card's entrance has played once. */
  enter: boolean;
  onEntered: () => void;
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

function FindingMarkdown({ finding, projectRoot, projectId, conversationId }: {
  finding: string;
  projectRoot: string;
  projectId: string;
  conversationId: string;
}): React.JSX.Element {
  const Markdown = useLoadedSurface(loadFindingMarkdown, true);
  return Markdown ? (
    <Markdown
      content={finding}
      projectRoot={projectRoot}
      projectId={projectId}
      conversationId={conversationId}
      defaultCodeWrap
    />
  ) : <p className="watcher-finding-plain">{finding}</p>;
}

export function WatcherFindingCard({
  item,
  motionIndex,
  enter,
  onEntered,
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
  const delivery = item.delivery;
  const deliverable = delivery === null || delivery.state === "failed";
  const status = findingStatus(delivery, { sending, failure, watchedRunning });
  const statusState = sending
    ? "sending"
    : failure && (delivery === null || delivery.state === "failed") ? "failed" : delivery?.state ?? "none";
  const finding = item.finding ?? "";
  return (
    <article
      ref={(node) => cardRef(item.wakeId, node)}
      className="watcher-finding"
      aria-labelledby={titleId}
      data-wake-id={item.wakeId}
      data-delivery={delivery?.state ?? (sending ? "sending" : "none")}
      tabIndex={-1}
      data-enter={enter || undefined}
      style={{ "--motion-index": Math.min(motionIndex, 5) } as CSSProperties}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        delete event.currentTarget.dataset.enter;
        onEntered();
      }}
    >
      <header className="watcher-finding-header">
        <span className="watcher-finding-heading">
          <h3 id={titleId}>Finding</h3>
          {item.settledAt && (
            <time dateTime={item.settledAt}>· {watcherClockTime(item.settledAt)}</time>
          )}
        </span>
        <span className="watcher-finding-meta">Check {item.sequence}</span>
      </header>
      <div className="watcher-finding-body">
        <WatcherErrorBoundary fallback={<p className="watcher-finding-plain">{finding}</p>}>
          <FindingMarkdown
            finding={finding}
            projectRoot={projectRoot}
            projectId={projectId}
            conversationId={watchedConversationId}
          />
        </WatcherErrorBoundary>
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
            aria-disabled={sending || !online || undefined}
            onClick={() => { if (!sending && online) onDismiss(item); }}
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
        data-state={statusState}
      >
        {status}
      </p>
    </article>
  );
}
