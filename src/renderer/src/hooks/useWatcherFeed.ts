import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WatcherDelivery, WatcherFeedItem } from "@shared/watcher";
import type { WatcherActions, WatcherFeedResult } from "./useWatcherActions";
import { useDocumentVisibility } from "./useDocumentPresence";
import { watcherErrorText } from "../utils/watcherCopy";

export interface WatcherFeedState {
  items: WatcherFeedItem[];
  loaded: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
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
  fetchedRevision: number;
  pendingRevision: number;
}

const freshHead = (): HeadState => ({ inFlight: false, again: false, fetchedRevision: -1, pendingRevision: -1 });

function mergeHead(previous: Feed | null, result: WatcherFeedResult): Feed {
  const kept = previous?.linkId === result.linkId ? previous : null;
  const oldestHead = result.items.at(-1)?.sequence ?? Number.POSITIVE_INFINITY;
  const newestKept = kept?.items[0]?.sequence ?? Number.NEGATIVE_INFINITY;
  const paged = kept !== null && kept.pages > 0 && oldestHead <= newestKept + 1;
  return {
    linkId: result.linkId,
    items: [...result.items, ...(paged ? kept.items.filter(({ sequence }) => sequence < oldestHead) : [])],
    next: paged ? kept.next : result.next,
    pages: paged ? kept.pages : 0,
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

export function useWatcherFeed(
  linkId: string,
  feedRevision: number,
  actions: WatcherActions | null,
  active = true,
): WatcherFeedState {
  const visible = useDocumentVisibility();
  const [feed, setFeed] = useState<Feed | null>(null);
  const feedRef = useRef<Feed | null>(null);
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
  const commitFeed = useCallback((update: (previous: Feed | null) => Feed | null): Feed | null => {
    feedRef.current = update(feedRef.current);
    setFeed(feedRef.current);
    return feedRef.current;
  }, []);

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
    const refresh = async (): Promise<void> => {
      const result = await load.feed();
      if (generation.current !== owner) return;
      const merged = commitFeed((previous) => mergeHead(previous, result));
      setError(null);
      const oldest = merged && merged.pages > 0 ? merged.items.at(-1)?.sequence : undefined;
      if (oldest === undefined) return;
      const fresh = new Map<string, WatcherFeedItem>();
      let cursor = result.next;
      while (cursor && cursor.beforeSequence > oldest) {
        const page = await load.feed(cursor.beforeSequence);
        if (generation.current !== owner) return;
        for (const item of page.items) fresh.set(item.wakeId, item);
        cursor = page.next;
      }
      commitFeed((previous) => previous && { ...previous, items: previous.items.map((item) => fresh.get(item.wakeId) ?? item) });
    };
    void refresh().then(settle, (failure: unknown) => {
      if (generation.current !== owner) return;
      state.fetchedRevision = -1;
      setError(watcherErrorText(failure, "The watcher's findings could not be loaded."));
      settle();
    });
  }, [commitFeed]);

  useEffect(() => {
    generation.current += 1;
    head.current = freshHead();
    commitFeed(() => null);
    setError(null);
    setLoadingMore(false);
    setOverrides(new Map());
  }, [commitFeed, linkId]);

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
      commitFeed((previous) => previous?.linkId === result.linkId ? mergePage(previous, result) : previous);
    }, (failure: unknown) => {
      if (generation.current !== owner) return;
      setError(watcherErrorText(failure, "Earlier checks could not be loaded."));
    }).finally(() => {
      if (generation.current === owner) setLoadingMore(false);
    });
  }, [commitFeed, loadingMore, next]);

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
