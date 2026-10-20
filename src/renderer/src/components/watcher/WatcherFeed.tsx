import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { groupWatcherFeed } from "@shared/watcher-feed";
import type { WatcherDeliveryMode, WatcherFeedItem } from "@shared/watcher";
import type { WatcherActions } from "../../hooks/useWatcherActions";
import type { WatcherFeedState } from "../../hooks/useWatcherFeed";
import { runtimeCommandDelivery } from "../../utils/connectionMessages";
import { LoadingMark } from "../ui";
import { WatcherFindingCard } from "./WatcherFindingCard";
import { WatcherNoticeLine, WatcherReceiptGroup } from "./WatcherReceiptGroup";

export interface WatcherFeedProps {
  feed: WatcherFeedState;
  actions: WatcherActions | null;
  headingId: string;
  projectRoot: string;
  projectId: string;
  watchedConversationId: string;
  watchedRunning: boolean;
  steerable: boolean;
  online: boolean;
}

type FocusTarget = { kind: "status" | "card"; wakeId: string } | { kind: "heading" };

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : "The note could not be sent.";
}

/**
 * Findings and receipts, newest first. Findings are cards the user sends or
 * dismisses; quiet checks fold into receipts. Focus follows the action: to the
 * card's own status after Send, to the next card (or the heading) after
 * Dismiss.
 */
export function WatcherFeed({
  feed,
  actions,
  headingId,
  projectRoot,
  projectId,
  watchedConversationId,
  watchedRunning,
  steerable,
  online,
}: WatcherFeedProps): React.JSX.Element {
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(() => new Map());
  const deliveryIds = useRef(new Map<string, string>());
  const statusNodes = useRef(new Map<string, HTMLParagraphElement>());
  const cardNodes = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<FocusTarget | null>(null);
  const visible = useMemo(
    () => feed.items.filter((item) => item.delivery?.state !== "dismissed"),
    [feed.items],
  );
  const groups = useMemo(() => groupWatcherFeed(visible), [visible]);
  const findingIds = useMemo(
    () => visible.filter((item) => item.finding !== null && item.outcome === "finding").map(({ wakeId }) => wakeId),
    [visible],
  );

  const focusTarget = useCallback((target: FocusTarget): boolean => {
    const node = target.kind === "heading"
      ? document.getElementById(headingId)
      : target.kind === "status"
        ? statusNodes.current.get(target.wakeId)
        : cardNodes.current.get(target.wakeId);
    if (!node?.isConnected) return false;
    node.focus({ preventScroll: false });
    return true;
  }, [headingId]);

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    if (focusTarget(target)) pendingFocus.current = null;
  });

  const setSendingFor = (wakeId: string, value: boolean): void => {
    setSending((current) => {
      const next = new Set(current);
      if (value) next.add(wakeId);
      else next.delete(wakeId);
      return next;
    });
  };
  const setFailureFor = (wakeId: string, message: string | null): void => {
    setFailures((current) => {
      if (!message && !current.has(wakeId)) return current;
      const next = new Map(current);
      if (message) next.set(wakeId, message);
      else next.delete(wakeId);
      return next;
    });
  };

  const deliver = (item: WatcherFeedItem, mode: WatcherDeliveryMode): void => {
    if (!actions || sending.has(item.wakeId)) return;
    const deliveryId = deliveryIds.current.get(item.wakeId) ?? crypto.randomUUID();
    deliveryIds.current.set(item.wakeId, deliveryId);
    setSendingFor(item.wakeId, true);
    setFailureFor(item.wakeId, null);
    pendingFocus.current = { kind: "status", wakeId: item.wakeId };
    focusTarget(pendingFocus.current);
    void actions.deliver(item.wakeId, mode, deliveryId).then((result) => {
      deliveryIds.current.delete(item.wakeId);
      feed.applyDelivery(item.wakeId, result.delivery);
    }, (error: unknown) => {
      // An ambiguous timeout keeps the same delivery id so a retry cannot
      // deliver the note twice; a refused or unsent request starts over.
      if (runtimeCommandDelivery(error) !== "ambiguous") deliveryIds.current.delete(item.wakeId);
      setFailureFor(item.wakeId, failureText(error));
    }).finally(() => {
      setSendingFor(item.wakeId, false);
    });
  };

  const dismiss = (item: WatcherFeedItem): void => {
    if (!actions || sending.has(item.wakeId)) return;
    const index = findingIds.indexOf(item.wakeId);
    const nextId = findingIds[index + 1] ?? null;
    setSendingFor(item.wakeId, true);
    setFailureFor(item.wakeId, null);
    void actions.dismiss(item.wakeId).then((result) => {
      pendingFocus.current = nextId ? { kind: "card", wakeId: nextId } : { kind: "heading" };
      feed.applyDelivery(item.wakeId, result.delivery);
    }, (error: unknown) => {
      setFailureFor(item.wakeId, error instanceof Error ? error.message : "The finding could not be dismissed.");
      pendingFocus.current = { kind: "status", wakeId: item.wakeId };
    }).finally(() => {
      setSendingFor(item.wakeId, false);
    });
  };

  const registerStatus = useCallback((wakeId: string, node: HTMLParagraphElement | null) => {
    if (node) statusNodes.current.set(wakeId, node);
    else statusNodes.current.delete(wakeId);
  }, []);
  const registerCard = useCallback((wakeId: string, node: HTMLElement | null) => {
    if (node) cardNodes.current.set(wakeId, node);
    else cardNodes.current.delete(wakeId);
  }, []);

  return (
    <section className="watcher-feed" aria-labelledby={headingId}>
      <h3 id={headingId} className="watcher-feed-heading" tabIndex={-1}>Findings</h3>
      {!feed.loaded && !feed.error && (
        <p className="watcher-feed-empty"><LoadingMark label="Loading checks" /> Loading checks…</p>
      )}
      {feed.error && (
        <p className="watcher-feed-error" role="alert">
          {feed.error}
          <button type="button" className="secondary-button" onClick={feed.retry}>Retry</button>
        </p>
      )}
      {feed.loaded && groups.length === 0 && (
        <p className="watcher-feed-empty">
          No checks yet. The watcher checks when something in the main chat settles.
        </p>
      )}
      {groups.length > 0 && (
        <ol className="watcher-feed-list" aria-label="Watcher findings">
          {groups.map((group, index) => (
            <li key={group.key} className="watcher-feed-entry" data-kind={group.kind === "receipts" ? "receipts" : group.item.outcome === "finding" ? "finding" : "notice"}>
              {group.kind === "receipts" ? (
                <WatcherReceiptGroup group={group} motionIndex={index} />
              ) : group.item.outcome === "finding" && group.item.finding !== null ? (
                <WatcherFindingCard
                  item={group.item}
                  motionIndex={index}
                  projectRoot={projectRoot}
                  projectId={projectId}
                  watchedConversationId={watchedConversationId}
                  watchedRunning={watchedRunning}
                  steerable={steerable}
                  sending={sending.has(group.item.wakeId)}
                  failure={failures.get(group.item.wakeId) ?? null}
                  online={online && actions !== null}
                  onDeliver={deliver}
                  onDismiss={dismiss}
                  statusRef={registerStatus}
                  cardRef={registerCard}
                />
              ) : (
                <WatcherNoticeLine item={group.item} motionIndex={index} />
              )}
            </li>
          ))}
        </ol>
      )}
      {feed.hasMore && (
        <button
          type="button"
          className="watcher-feed-more"
          disabled={feed.loadingMore}
          onClick={feed.loadMore}
        >
          {feed.loadingMore ? "Loading earlier checks…" : "Show earlier checks"}
        </button>
      )}
    </section>
  );
}
