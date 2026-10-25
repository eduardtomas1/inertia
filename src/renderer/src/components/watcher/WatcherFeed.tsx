import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { groupWatcherFeed } from "@shared/watcher-feed";
import type { WatcherDeliveryMode, WatcherFeedItem } from "@shared/watcher";
import type { WatcherActions } from "../../hooks/useWatcherActions";
import type { WatcherFeedState } from "../../hooks/useWatcherFeed";
import { runtimeCommandDelivery } from "../../utils/connectionMessages";
import { watcherErrorText } from "../../utils/watcherCopy";
import { LoadingMark } from "../ui";
import { WatcherFindingCard, type WatcherFindingAction, type WatcherFindingFailure } from "./WatcherFindingCard";
import { WatcherNoticeLine, WatcherReceiptGroup } from "./WatcherReceiptGroup";

interface WatcherFeedProps {
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
  readOnly?: boolean;
}

type FocusTarget = { kind: "status" | "card"; wakeId: string } | { kind: "heading" };

function isFinding(item: WatcherFeedItem): boolean {
  return item.outcome === "finding" && item.finding !== null;
}

function openFindingsFirst(items: readonly WatcherFeedItem[]): WatcherFeedItem[] {
  let lastOpen = -1;
  items.forEach((item, index) => {
    if (isFinding(item) && item.resolvedBySequence === null) lastOpen = index;
  });
  const head = items.slice(0, lastOpen + 1);
  const resolved = head.filter((item) => isFinding(item) && item.resolvedBySequence !== null);
  if (resolved.length === 0) return [...items];
  return [...head.filter((item) => !resolved.includes(item)), ...resolved, ...items.slice(lastOpen + 1)];
}

const enteredEntries = new Set<string>();
const MAX_ENTERED_ENTRIES = 2_000;

function markEntered(key: string): void {
  if (enteredEntries.size >= MAX_ENTERED_ENTRIES) enteredEntries.clear();
  enteredEntries.add(key);
}

export function resetWatcherFeedMotion(): void {
  enteredEntries.clear();
}

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
  readOnly = true,
}: WatcherFeedProps): React.JSX.Element {
  const [pending, setPending] = useState<ReadonlyMap<string, WatcherFindingAction>>(() => new Map());
  const [failures, setFailures] = useState<ReadonlyMap<string, WatcherFindingFailure>>(() => new Map());
  const deliveryIds = useRef(new Map<string, string>());
  const statusNodes = useRef(new Map<string, HTMLParagraphElement>());
  const cardNodes = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<FocusTarget | null>(null);
  const visible = useMemo(
    () => openFindingsFirst(feed.items.filter((item) => item.delivery?.state !== "dismissed")),
    [feed.items],
  );
  const groups = useMemo(() => groupWatcherFeed(visible), [visible]);
  const findingIds = useMemo(
    () => visible.filter(isFinding).map(({ wakeId }) => wakeId),
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

  const setPendingFor = (wakeId: string, action: WatcherFindingAction | null): void => {
    setPending((current) => {
      const next = new Map(current);
      if (action) next.set(wakeId, action);
      else next.delete(wakeId);
      return next;
    });
  };
  const setFailureFor = (wakeId: string, failure: WatcherFindingFailure | null): void => {
    setFailures((current) => {
      if (!failure && !current.has(wakeId)) return current;
      const next = new Map(current);
      if (failure) next.set(wakeId, failure);
      else next.delete(wakeId);
      return next;
    });
  };

  const deliver = (item: WatcherFeedItem, mode: WatcherDeliveryMode): void => {
    if (!actions || pending.has(item.wakeId)) return;
    const deliveryId = deliveryIds.current.get(item.wakeId) ?? crypto.randomUUID();
    deliveryIds.current.set(item.wakeId, deliveryId);
    setPendingFor(item.wakeId, "send");
    setFailureFor(item.wakeId, null);
    pendingFocus.current = { kind: "status", wakeId: item.wakeId };
    focusTarget(pendingFocus.current);
    void actions.deliver(item.wakeId, mode, deliveryId).then((result) => {
      deliveryIds.current.delete(item.wakeId);
      feed.applyDelivery(item.wakeId, result.delivery);
    }, (error: unknown) => {
      if (runtimeCommandDelivery(error) !== "ambiguous") deliveryIds.current.delete(item.wakeId);
      setFailureFor(item.wakeId, { action: "send", message: watcherErrorText(error, "The note could not be sent.") });
    }).finally(() => {
      setPendingFor(item.wakeId, null);
    });
  };

  const dismiss = (item: WatcherFeedItem): void => {
    if (!actions || pending.has(item.wakeId)) return;
    const index = findingIds.indexOf(item.wakeId);
    const nextId = findingIds[index + 1] ?? null;
    setPendingFor(item.wakeId, "dismiss");
    setFailureFor(item.wakeId, null);
    void actions.dismiss(item.wakeId).then((result) => {
      pendingFocus.current = nextId ? { kind: "card", wakeId: nextId } : { kind: "heading" };
      feed.applyDelivery(item.wakeId, result.delivery);
    }, (error: unknown) => {
      setFailureFor(item.wakeId, {
        action: "dismiss",
        message: watcherErrorText(error, "The finding could not be dismissed."),
      });
      pendingFocus.current = { kind: "status", wakeId: item.wakeId };
    }).finally(() => {
      setPendingFor(item.wakeId, null);
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
    <section className="watcher-feed" aria-label="Checks">
      {!feed.loaded && !feed.error && (
        <p className="watcher-feed-empty" role="status"><LoadingMark aria-hidden="true" /> Loading checks…</p>
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
        <ol className="watcher-feed-list" aria-label="Watcher checks">
          {groups.map((group, index) => {
            const motionKey = `${linkId}:${group.key}`;
            const enter = !enteredEntries.has(motionKey);
            const onEntered = (): void => markEntered(motionKey);
            return (
            <li key={group.key} className="watcher-feed-entry" data-kind={group.kind === "receipts" ? "receipts" : group.item.outcome === "finding" ? "finding" : "notice"}>
              {group.kind === "receipts" ? (
                <WatcherReceiptGroup group={group} readOnly={readOnly} motionIndex={index} enter={enter} onEntered={onEntered} />
              ) : isFinding(group.item) ? (
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
                  pending={pending.get(group.item.wakeId) ?? null}
                  failure={failures.get(group.item.wakeId) ?? null}
                  online={online && actions !== null}
                  onDeliver={deliver}
                  onDismiss={dismiss}
                  statusRef={registerStatus}
                  cardRef={registerCard}
                />
              ) : (
                <WatcherNoticeLine item={group.item} readOnly={readOnly} motionIndex={index} enter={enter} onEntered={onEntered} />
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
