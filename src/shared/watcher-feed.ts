import { STEERABLE_HARNESS_IDS } from "./follow-up-steer";
import type { WatcherFeedItem } from "./watcher";

/** A feed item, optionally carrying how many read-only commands its check ran. */
export type WatcherFeedEntry = WatcherFeedItem & { commandsRun?: number };

export interface WatcherReceiptGroup {
  kind: "receipts";
  /** Stable while newer quiet checks join: keyed by the oldest check in the group. */
  key: string;
  items: WatcherFeedEntry[];
  count: number;
  firstAt: string;
  lastAt: string;
  /** Total read-only commands, or null when no item in the group reported a count. */
  commandsRun: number | null;
}

export interface WatcherFeedSingle {
  kind: "item";
  key: string;
  item: WatcherFeedEntry;
}

export type WatcherFeedGroup = WatcherReceiptGroup | WatcherFeedSingle;

function quiet(item: WatcherFeedEntry): boolean {
  return item.state === "settled" && item.outcome === "silent";
}

function receipt(items: WatcherFeedEntry[]): WatcherReceiptGroup {
  const oldest = items.reduce((left, right) => (right.sequence < left.sequence ? right : left));
  const starts = items.map(({ createdAt }) => createdAt).sort();
  const ends = items.map(({ settledAt, createdAt }) => settledAt ?? createdAt).sort();
  const counts = items
    .map(({ commandsRun }) => commandsRun)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
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
export function groupWatcherFeed(items: readonly WatcherFeedEntry[]): WatcherFeedGroup[] {
  const groups: WatcherFeedGroup[] = [];
  let run: WatcherFeedEntry[] = [];
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
  return watchedRunning
    && typeof watchedHarnessId === "string"
    && (STEERABLE_HARNESS_IDS as readonly string[]).includes(watchedHarnessId);
}
