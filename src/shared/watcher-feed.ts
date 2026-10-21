import { supportsActiveParentFollowUp } from "./follow-up-steer";
import type { WatcherFeedItem } from "./watcher";

export type WatcherFeedEntry = WatcherFeedItem;

export interface WatcherReceiptGroup {
  kind: "receipts";
  /** Stable while newer quiet checks join: keyed by the oldest check in the group. */
  key: string;
  items: WatcherFeedItem[];
  count: number;
  firstAt: string;
  lastAt: string;
  /** Total read-only commands, or null when no item in the group reported a count. */
  commandsRun: number | null;
}

interface WatcherFeedSingle {
  kind: "item";
  key: string;
  item: WatcherFeedItem;
}

type WatcherFeedGroup = WatcherReceiptGroup | WatcherFeedSingle;

function quiet(item: WatcherFeedItem): boolean {
  return item.state === "settled" && item.outcome === "silent";
}

function receipt(items: WatcherFeedItem[]): WatcherReceiptGroup {
  const oldest = items.reduce((left, right) => (right.sequence < left.sequence ? right : left));
  const starts = items.map(({ createdAt }) => createdAt).sort();
  const ends = items.map(({ settledAt, createdAt }) => settledAt ?? createdAt).sort();
  const counts = items
    .map(({ commandsRun }) => commandsRun)
    .filter((value): value is number => value !== undefined);
  return {
    kind: "receipts",
    key: `receipts:${oldest.wakeId}`,
    items,
    count: items.length,
    firstAt: starts[0]!,
    lastAt: ends.at(-1)!,
    commandsRun: counts.length === 0 ? null : counts.reduce((sum, value) => sum + value, 0),
  };
}

/**
 * Groups consecutive quiet (`silent`) checks into one receipt and keeps every
 * other item (finding, failure, notice, or a check still running) on its own,
 * where it ends the current receipt. Input order is preserved.
 */
export function groupWatcherFeed(items: readonly WatcherFeedItem[]): WatcherFeedGroup[] {
  const groups: WatcherFeedGroup[] = [];
  let run: WatcherFeedItem[] = [];
  const flush = () => {
    if (run.length > 0) groups.push(receipt(run));
    run = [];
  };
  for (const item of items) {
    if (quiet(item)) {
      run.push(item);
      continue;
    }
    flush();
    groups.push({ kind: "item", key: `item:${item.wakeId}`, item });
  }
  flush();
  return groups;
}

/** Steer is offered only while the watched turn runs on a harness that accepts it. */
export function steerAvailable(watchedHarnessId: string | null | undefined, watchedRunning: boolean): boolean {
  return watchedRunning && supportsActiveParentFollowUp(watchedHarnessId ?? null);
}
