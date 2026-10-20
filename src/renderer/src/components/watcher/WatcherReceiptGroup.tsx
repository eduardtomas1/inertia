import type { CSSProperties } from "react";

import type { WatcherFeedEntry, WatcherReceiptGroup as ReceiptGroup } from "@shared/watcher-feed";
import {
  watcherClockTime,
  watcherEventsText,
  watcherOutcomeText,
  watcherTriggerText,
} from "../../utils/watcherCopy";

function guardNote(item: WatcherFeedEntry): string | null {
  if (item.guardState === "inconclusive") return "Checkout check inconclusive: other work was busy";
  if (item.guardState === "unavailable") return "No Git fingerprint for this checkout";
  return null;
}

function digestNote(item: WatcherFeedEntry): string | null {
  const parts = [
    item.itemsTruncated > 0 ? `${item.itemsTruncated} shortened` : null,
    item.itemsOmitted > 0 ? `${item.itemsOmitted} left out` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function commandsNote(count: number | null | undefined): string | null {
  if (typeof count !== "number" || count <= 0) return null;
  return `ran ${count} read-only ${count === 1 ? "command" : "commands"}`;
}

/** One check, as listed inside a receipt or on its own for a notice. */
export function WatcherCheckLine({ item }: { item: WatcherFeedEntry }): React.JSX.Element {
  const notes = [
    watcherTriggerText(item.trigger),
    watcherEventsText(item.eventsCovered),
    commandsNote(item.commandsRun),
    digestNote(item),
    guardNote(item),
  ].filter((note): note is string => Boolean(note));
  return (
    <span className="watcher-check-line">
      <span className="watcher-check-title">
        Check {item.sequence}
        <time dateTime={item.settledAt ?? item.createdAt}>{watcherClockTime(item.settledAt ?? item.createdAt)}</time>
      </span>
      <span className="watcher-check-notes">{notes.join(" · ")}</span>
    </span>
  );
}

function receiptSummary(group: ReceiptGroup): string {
  const times = group.count === 1 ? "once" : `${group.count} times`;
  const since = group.count === 1
    ? `at ${watcherClockTime(group.firstAt)}`
    : `since ${watcherClockTime(group.firstAt)}`;
  const commands = commandsNote(group.commandsRun);
  return `Checked ${times} ${since} · nothing to report${commands ? ` · ${commands}` : ""}`;
}

/** Consecutive quiet checks, folded into one calm receipt. */
export function WatcherReceiptGroup({
  group,
  motionIndex,
}: {
  group: ReceiptGroup;
  motionIndex: number;
}): React.JSX.Element {
  return (
    <details
      className="watcher-receipt"
      style={{ "--motion-index": Math.min(motionIndex, 5) } as CSSProperties}
    >
      <summary>
        <span className="watcher-receipt-mark" aria-hidden="true" />
        <span>{receiptSummary(group)}</span>
      </summary>
      <ol className="watcher-receipt-checks">
        {group.items.map((item) => (
          <li key={item.wakeId}><WatcherCheckLine item={item} /></li>
        ))}
      </ol>
    </details>
  );
}

/** A check that ended any other way than quietly or with a finding. */
export function WatcherNoticeLine({
  item,
  motionIndex,
}: {
  item: WatcherFeedEntry;
  motionIndex: number;
}): React.JSX.Element {
  const running = item.state !== "settled";
  return (
    <div
      className="watcher-receipt is-notice"
      data-outcome={item.outcome ?? "running"}
      style={{ "--motion-index": Math.min(motionIndex, 5) } as CSSProperties}
    >
      <span className="watcher-receipt-mark" aria-hidden="true" />
      <span className="watcher-notice-line">
        <strong>{running ? `Check ${item.sequence} · checking now` : watcherOutcomeText(item.outcome)}</strong>
        {!running && <WatcherCheckLine item={item} />}
      </span>
    </div>
  );
}
