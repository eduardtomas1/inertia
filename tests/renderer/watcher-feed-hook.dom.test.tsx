import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WatcherFeedItem } from "../../src/shared/watcher";
import type { WatcherActions, WatcherFeedResult } from "../../src/renderer/src/hooks/useWatcherActions";
import { useWatcherFeed } from "../../src/renderer/src/hooks/useWatcherFeed";
import { LINK_ID, feedItem } from "./watcher-fixtures";

const OTHER_LINK = "77777777-7777-4777-8777-777777777777";

/** Feed requests that resolve only when the test says so. */
function deferredFeed() {
  const calls: Array<{ linkId: string; before: number | undefined; resolve: (result: WatcherFeedResult) => void }> = [];
  const actionsFor = (linkId: string): WatcherActions => ({
    feed: (before?: number) => new Promise<WatcherFeedResult>((resolve) => { calls.push({ linkId, before, resolve }); }),
  }) as unknown as WatcherActions;
  const page = (linkId: string, items: WatcherFeedItem[], next: number | null = null): WatcherFeedResult => ({
    kind: "watcher.feed",
    linkId,
    feedRevision: 1,
    items,
    next: next === null ? null : { beforeSequence: next },
  } as WatcherFeedResult);
  return { calls, actionsFor, page };
}

describe("useWatcherFeed", () => {
  it("coalesces rapid revisions into one trailing request for the newest", async () => {
    const feed = deferredFeed();
    const actions = feed.actionsFor(LINK_ID);
    const { rerender } = renderHook(({ revision }) => useWatcherFeed(LINK_ID, revision, actions), {
      initialProps: { revision: 1 },
    });
    expect(feed.calls).toHaveLength(1);
    rerender({ revision: 2 });
    rerender({ revision: 3 });
    rerender({ revision: 4 });
    expect(feed.calls).toHaveLength(1);
    await act(async () => { feed.calls[0]!.resolve(feed.page(LINK_ID, [feedItem(1)])); });
    await waitFor(() => expect(feed.calls).toHaveLength(2));
    await act(async () => { feed.calls[1]!.resolve(feed.page(LINK_ID, [feedItem(2), feedItem(1)])); });
    expect(feed.calls).toHaveLength(2);
  });

  it("drops a response for a link that changed while it was in flight", async () => {
    const feed = deferredFeed();
    const first = feed.actionsFor(LINK_ID);
    const second = feed.actionsFor(OTHER_LINK);
    const { result, rerender } = renderHook(({ linkId, actions }) => useWatcherFeed(linkId, 1, actions), {
      initialProps: { linkId: LINK_ID, actions: first },
    });
    rerender({ linkId: OTHER_LINK, actions: second });
    await waitFor(() => expect(feed.calls.some(({ linkId }) => linkId === OTHER_LINK)).toBe(true));
    await act(async () => { feed.calls[0]!.resolve(feed.page(LINK_ID, [feedItem(9)])); });
    expect(result.current.items).toEqual([]);
    const other = feed.calls.find(({ linkId }) => linkId === OTHER_LINK)!;
    await act(async () => { other.resolve(feed.page(OTHER_LINK, [feedItem(3)])); });
    expect(result.current.items.map(({ sequence }) => sequence)).toEqual([3]);
  });

  it("keeps loaded earlier pages when the newest page refreshes", async () => {
    const feed = deferredFeed();
    const actions = feed.actionsFor(LINK_ID);
    const { result, rerender } = renderHook(({ revision }) => useWatcherFeed(LINK_ID, revision, actions), {
      initialProps: { revision: 1 },
    });
    await act(async () => { feed.calls[0]!.resolve(feed.page(LINK_ID, [feedItem(5), feedItem(4)], 4)); });
    act(() => result.current.loadMore());
    await act(async () => { feed.calls[1]!.resolve(feed.page(LINK_ID, [feedItem(3), feedItem(2)])); });
    expect(result.current.items.map(({ sequence }) => sequence)).toEqual([5, 4, 3, 2]);
    rerender({ revision: 2 });
    await waitFor(() => expect(feed.calls).toHaveLength(3));
    await act(async () => { feed.calls[2]!.resolve(feed.page(LINK_ID, [feedItem(6), feedItem(5)], 5)); });
    expect(result.current.items.map(({ sequence }) => sequence)).toEqual([6, 5, 4, 3, 2]);
    expect(result.current.hasMore).toBe(false);
  });
});
