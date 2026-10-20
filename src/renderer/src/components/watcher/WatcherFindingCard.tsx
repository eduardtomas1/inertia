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
  { pending, failure, watchedRunning }: {
    pending: WatcherFindingAction | null;
    failure: WatcherFindingFailure | null;
    watchedRunning: boolean;
  },
): string {
  if (pending) return pending === "dismiss" ? "Dismissing…" : "Sending…";
  if (failure && (delivery === null || delivery.state === "failed")) {
    return failure.action === "dismiss" ? failure.message : `Not sent · ${failure.message}`;
  }
  if (!delivery) return "";
  return watcherDeliveryText(delivery, watchedRunning);
}

function splitFinding(finding: string): { title: string; body: string } {
  const lines = finding.trim().split(/\r?\n/u);
  const first = lines[0] ?? "";
  const title = first.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+)/u, "").replaceAll("**", "").replaceAll("`", "").trim();
  return { title, body: lines.slice(1).join("\n").trim() };
}

export type WatcherFindingAction = "send" | "dismiss";

export interface WatcherFindingFailure {
  action: WatcherFindingAction;
  message: string;
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
  pending: WatcherFindingAction | null;
  failure: WatcherFindingFailure | null;
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
  pending,
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
  const sending = pending !== null;
  const status = findingStatus(delivery, { pending, failure, watchedRunning });
  const statusState = sending
    ? "sending"
    : failure && (delivery === null || delivery.state === "failed") ? "failed" : delivery?.state ?? "none";
  const { title, body } = splitFinding(item.finding ?? "");
  const time = watcherClockTime(item.settledAt);
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
      <h3 id={titleId} className="watcher-finding-title">{title}</h3>
      {body && (
        <div className="watcher-finding-body">
          <WatcherErrorBoundary fallback={<p className="watcher-finding-plain">{body}</p>}>
            <FindingMarkdown
              finding={body}
              projectRoot={projectRoot}
              projectId={projectId}
              conversationId={watchedConversationId}
            />
          </WatcherErrorBoundary>
        </div>
      )}
      <p className="watcher-finding-meta">
        Check {item.sequence}
        {time && <> · <time dateTime={item.settledAt ?? undefined}>{time}</time></>}
      </p>
      {item.resolvedBySequence !== null && (
        <p className="watcher-finding-resolved">Resolved in check {item.resolvedBySequence}</p>
      )}
      {deliverable && (
        <div className="watcher-finding-actions">
          <WatcherDeliverButton
            disabled={sending || !online}
            steerable={steerable}
            onDeliver={(mode) => onDeliver(item, mode)}
          />
          <button
            type="button"
            className="watcher-text-button"
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
