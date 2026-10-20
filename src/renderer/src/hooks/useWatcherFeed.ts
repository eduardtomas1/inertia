import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WatcherDelivery, WatcherFeedItem } from "@shared/watcher";
import type { WatcherActions, WatcherFeedResult } from "./useWatcherActions";
import { useDocumentVisibility } from "./useDocumentPresence";

export interface WatcherFeedState {
  /** Newest first. */
  items: WatcherFeedItem[];
  loaded: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** The watcher chat's total token use from the newest page, or null while unknown. */
  usageTokens: number | null;
  loadMore: () => void;
  retry: () => void;
  applyDelivery: (wakeId: string, delivery: WatcherDelivery) => void;
}

interface Feed {
  linkId: string;
  items: WatcherFeedItem[];
  next: WatcherFeedResult["next"];
  pages: number;
  usageTokens: number | null;
}

interface HeadState {
  inFlight: boolean;
  again: boolean;
  /** Revision requested by the in-flight or last successful head fetch. */
  fetchedRevision: number;
  pendingRevision: number;
}

const freshHead = (): HeadState => ({ inFlight: false, again: false, fetchedRevision: -1, pendingRevision: -1 });

function mergeHead(previous: Feed | null, result: WatcherFeedResult): Feed {
  const kept = previous?.linkId === result.linkId ? previous : null;
  const oldestHead = result.items.at(-1)?.sequence ?? Number.POSITIVE_INFINITY;
  const paged = kept !== null && kept.pages > 0;
  return {
    linkId: result.linkId,
    items: [...result.items, ...(paged ? kept.items.filter(({ sequence }) => sequence < oldestHead) : [])],
    next: paged ? kept.next : result.next,
    pages: kept?.pages ?? 0,
    usageTokens: result.usage?.totalTokens ?? null,
  };
}

function mergePage(previous: Feed, result: WatcherFeedResult): Feed {
  const known = new Set(previous.items.map(({ wakeId }) => wakeId));
  return {
    ...previous,
    items: [...previous.items, ...result.items.filter(({ wakeId }) => !known.has(wakeId))],
    next: result.next,
    pages: previous.pages + 1,
  };
}

function newerDelivery(server: WatcherDelivery | null, local: WatcherDelivery | undefined): WatcherDelivery | null {
  if (!local) return server;
  if (!server) return local;
  return local.at >= server.at ? local : server;
}

/**
 * Feed by request, the Background tasks precedent: fetched when the dock
 * mounts and whenever the link's `feedRevision` moves, coalesced while a
 * request is in flight and deferred while the window is hidden or the dock
 * is collapsed. It never subscribes to the watcher chat's detail stream.
 */
export function useWatcherFeed(
  linkId: string,
  feedRevision: number,
  actions: WatcherActions | null,
  active = true,
): WatcherFeedState {
  const visible = useDocumentVisibility();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, WatcherDelivery>>(() => new Map());
  const [retryVersion, setRetryVersion] = useState(0);
  const actionsRef = useRef(actions);
  const generation = useRef(0);
  const head = useRef<HeadState>(freshHead());
  useEffect(() => {
    actionsRef.current = actions;
  });

  const fetchHead = useCallback((revision: number): void => {
    const state = head.current;
    const load = actionsRef.current;
    if (!load) return;
    if (state.inFlight) {
      state.again = true;
      state.pendingRevision = revision;
      return;
    }
    state.inFlight = true;
    state.fetchedRevision = revision;
    const owner = generation.current;
    const settle = (): void => {
      if (generation.current !== owner || head.current !== state) return;
      state.inFlight = false;
      if (!state.again) return;
      state.again = false;
      fetchHead(state.pendingRevision);
    };
    void load.feed().then((result) => {
      if (generation.current !== owner) return;
      setFeed((previous) => mergeHead(previous, result));
      setError(null);
      settle();
    }, (failure: unknown) => {
      if (generation.current !== owner) return;
      state.fetchedRevision = -1;
      setError(failure instanceof Error ? failure.message : "The watcher's findings could not be loaded.");
      settle();
    });
  }, []);

  useEffect(() => {
    generation.current += 1;
    head.current = freshHead();
    setFeed(null);
    setError(null);
    setLoadingMore(false);
    setOverrides(new Map());
  }, [linkId]);

  const available = actions !== null;
  useEffect(() => {
    if (!available || !visible || !active) return;
    if (head.current.fetchedRevision === feedRevision) return;
    fetchHead(feedRevision);
  }, [active, available, feedRevision, fetchHead, linkId, retryVersion, visible]);

  const next = feed?.linkId === linkId ? feed.next : null;
  const loadMore = useCallback((): void => {
    const load = actionsRef.current;
    if (!next || !load || loadingMore) return;
    const owner = generation.current;
    setLoadingMore(true);
    void load.feed(next.beforeSequence).then((result) => {
      if (generation.current !== owner) return;
      setFeed((previous) => previous?.linkId === result.linkId ? mergePage(previous, result) : previous);
    }, (failure: unknown) => {
      if (generation.current !== owner) return;
      setError(failure instanceof Error ? failure.message : "Earlier checks could not be loaded.");
    }).finally(() => {
      if (generation.current === owner) setLoadingMore(false);
    });
  }, [loadingMore, next]);

  const retry = useCallback((): void => {
    head.current.fetchedRevision = -1;
    setRetryVersion((version) => version + 1);
  }, []);

  const applyDelivery = useCallback((wakeId: string, delivery: WatcherDelivery): void => {
    setOverrides((current) => new Map(current).set(wakeId, delivery));
  }, []);

  const items = feed?.linkId === linkId ? feed.items : null;
  const merged = useMemo(() => (items ?? []).map((item) => {
    const delivery = newerDelivery(item.delivery, overrides.get(item.wakeId));
    return delivery === item.delivery ? item : { ...item, delivery };
  }), [items, overrides]);

  return {
    items: merged,
    loaded: items !== null,
    error,
    hasMore: next !== null,
    loadingMore,
    usageTokens: feed?.linkId === linkId ? feed.usageTokens : null,
    loadMore,
    retry,
    applyDelivery,
  };
}
