import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
  linkId: string;
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
 * Feed entries whose entrance already played, across remounts and collapses:
 * a card or receipt animates in once, never again when the dock reopens or
 * the user returns to the chat.
 */
const enteredEntries = new Set<string>();
const MAX_ENTERED_ENTRIES = 2_000;

function markEntered(key: string): void {
  if (enteredEntries.size >= MAX_ENTERED_ENTRIES) enteredEntries.clear();
  enteredEntries.add(key);
}

/** Test seam: lets every entry animate again. */
export function resetWatcherFeedMotion(): void {
  enteredEntries.clear();
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
  linkId,
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

  // The runtime's word wins: once the feed shows a note queued or sent (for
  // example after an ambiguous timeout), drop the local failure and its id.
  useEffect(() => {
    const settled = feed.items.filter(({ wakeId, delivery }) =>
      failures.has(wakeId) && (delivery?.state === "queued" || delivery?.state === "sent"));
    if (settled.length === 0) return;
    for (const { wakeId } of settled) deliveryIds.current.delete(wakeId);
    setFailures((current) => {
      const next = new Map(current);
      for (const { wakeId } of settled) next.delete(wakeId);
      return next;
    });
  }, [failures, feed.items]);

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
    <section className="watcher-feed" aria-label="Findings">
      {!feed.loaded && !feed.error && (
        <p className="watcher-feed-empty"><LoadingMark label="Loading checks" /> Loading checks…</p>
      )}
      {feed.error && (
        <p className="watcher-feed-error" role="alert">
          {feed.error}
          <button type="button" className="watcher-text-button" onClick={feed.retry}>Retry</button>
        </p>
      )}
      {feed.loaded && groups.length === 0 && (
        <p className="watcher-feed-empty">No checks yet</p>
      )}
      {groups.length > 0 && (
        <ol className="watcher-feed-list" aria-label="Watcher findings">
          {groups.map((group, index) => {
            const motionKey = `${linkId}:${group.key}`;
            const enter = !enteredEntries.has(motionKey);
            const onEntered = (): void => markEntered(motionKey);
            return (
            <li key={group.key} className="watcher-feed-entry" data-kind={group.kind === "receipts" ? "receipts" : group.item.outcome === "finding" ? "finding" : "notice"}>
              {group.kind === "receipts" ? (
                <WatcherReceiptGroup group={group} motionIndex={index} enter={enter} onEntered={onEntered} />
              ) : group.item.outcome === "finding" && group.item.finding !== null ? (
                <WatcherFindingCard
                  item={group.item}
                  motionIndex={index}
                  enter={enter}
                  onEntered={onEntered}
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
                <WatcherNoticeLine item={group.item} motionIndex={index} enter={enter} onEntered={onEntered} />
              )}
            </li>
            );
          })}
        </ol>
      )}
      {feed.hasMore && (
        <button
          type="button"
          className="watcher-feed-more"
          aria-disabled={feed.loadingMore || undefined}
          onClick={() => { if (!feed.loadingMore) feed.loadMore(); }}
        >
          {feed.loadingMore ? "Loading earlier checks…" : "Show earlier checks"}
        </button>
      )}
    </section>
  );
}
