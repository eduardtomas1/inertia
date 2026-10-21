import { describe, expect, it } from "vitest";

import { watcherFeedItemSchema, type WatcherFeedItem, type WatcherWakeOutcome } from "../../src/shared/watcher";
import { groupWatcherFeed } from "../../src/shared/watcher-feed";

function item(
  sequence: number,
  outcome: WatcherWakeOutcome | null,
  extra: Partial<WatcherFeedItem> = {},
): WatcherFeedItem {
  const minute = String(sequence).padStart(2, "0");
  const settledState = outcome !== null;
  return {
    wakeId: `00000000-0000-4000-8000-0000000000${minute}`,
    sequence,
    watcherTurnId: `turn-${sequence}`,
    watchedTurnId: "watched-turn",
    trigger: "activity",
    outcome,
    state: settledState ? "settled" : "running",
    eventsCovered: 1,
    itemsTruncated: 0,
    itemsOmitted: 0,
    guardState: settledState ? "clean" : null,
    guardPaths: [],
    finding: outcome === "finding" ? "- Missing test" : null,
    delivery: null,
    createdAt: `2026-10-19T10:${minute}:00.000Z`,
    settledAt: settledState ? `2026-10-19T10:${minute}:30.000Z` : null,
    resolvedBySequence: null,
    commandsDeclined: 0,
    ...extra,
  };
}

describe("groupWatcherFeed", () => {
  it("uses items that match the feed item schema", () => {
    for (const entry of [item(1, "silent"), item(2, "finding"), item(3, null)]) {
      expect(watcherFeedItemSchema.safeParse(entry).success).toBe(true);
    }
  });

  it("merges consecutive silent checks into one receipt with count, span and commands", () => {
    const groups = groupWatcherFeed([
      item(1, "silent", { commandsRun: 2 }),
      item(2, "silent"),
      item(3, "silent", { commandsRun: 1 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "receipts",
      count: 3,
      firstAt: "2026-10-19T10:01:00.000Z",
      lastAt: "2026-10-19T10:03:30.000Z",
      commandsRun: 3,
      key: `receipts:${item(1, "silent").wakeId}`,
    });
  });

  it("reports no command total when no check carried one", () => {
    const [group] = groupWatcherFeed([item(1, "silent"), item(2, "silent")]);
    expect(group).toMatchObject({ kind: "receipts", commandsRun: null });
  });

  it("ends a receipt at a finding, a failure, a notice or a running check", () => {
    const groups = groupWatcherFeed([
      item(1, "silent"),
      item(2, "silent"),
      item(3, "finding"),
      item(4, "silent"),
      item(5, "failed"),
      item(6, "write-attempt"),
      item(7, "silent"),
      item(8, null),
      item(9, "permission-declined"),
      item(10, "silent"),
      item(11, "silent"),
    ]);
    expect(groups.map((group) => (group.kind === "receipts" ? `r${group.count}` : group.item.outcome ?? "running")))
      .toEqual(["r2", "finding", "r1", "failed", "write-attempt", "r1", "running", "permission-declined", "r2"]);
  });

  it("keeps receipt keys stable as newer quiet checks join, in either order", () => {
    const newestFirst = groupWatcherFeed([item(3, "silent"), item(2, "silent")]);
    const withNewer = groupWatcherFeed([item(4, "silent"), item(3, "silent"), item(2, "silent")]);
    expect(withNewer[0]!.key).toBe(newestFirst[0]!.key);
    const oldestFirst = groupWatcherFeed([item(2, "silent"), item(3, "silent"), item(4, "silent")]);
    expect(oldestFirst[0]!.key).toBe(newestFirst[0]!.key);
    expect(new Set(groupWatcherFeed([item(1, "finding"), item(2, "silent")]).map(({ key }) => key)).size).toBe(2);
  });

  it("returns no groups for an empty feed", () => {
    expect(groupWatcherFeed([])).toEqual([]);
  });
});
