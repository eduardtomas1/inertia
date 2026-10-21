import type { WatcherFeedItem } from "./watcher";

export interface WatcherReceiptGroup {
  kind: "receipts";
  key: string;
  items: WatcherFeedItem[];
  count: number;
  firstAt: string;
  lastAt: string;
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
