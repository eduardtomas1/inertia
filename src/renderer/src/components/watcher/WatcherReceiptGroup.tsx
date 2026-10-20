import type { CSSProperties } from "react";
import { ChevronRight } from "lucide-react";

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

/** "7:32 PM" or "7:32–7:41 PM": the time range the receipt covers. */
function receiptTimes(group: ReceiptGroup): string {
  const first = watcherClockTime(group.firstAt);
  const last = watcherClockTime(group.lastAt);
  if (group.count === 1 || !last || first === last) return ` at ${first}`;
  // "7:32–7:41 PM": a shared day period is said once.
  const [firstClock, firstPeriod] = first.split(/\s/u);
  const [, lastPeriod] = last.split(/\s/u);
  return ` · ${firstPeriod && firstPeriod === lastPeriod ? firstClock : first}–${last}`;
}

function receiptSummary(group: ReceiptGroup): string {
  const times = group.count === 1 ? "once" : `${group.count} times`;
  const commands = commandsNote(group.commandsRun);
  return `Checked ${times}${receiptTimes(group)} · nothing to report${commands ? ` · ${commands}` : ""}`;
}

function enterProps(enter: boolean, onEntered: () => void) {
  return {
    "data-enter": enter || undefined,
    onAnimationEnd: (event: React.AnimationEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      delete event.currentTarget.dataset.enter;
      onEntered();
    },
  };
}

/** Consecutive quiet checks, folded into one calm receipt the user can open. */
export function WatcherReceiptGroup({
  group,
  motionIndex,
  enter,
  onEntered,
}: {
  group: ReceiptGroup;
  motionIndex: number;
  enter: boolean;
  onEntered: () => void;
}): React.JSX.Element {
  return (
    <details
      className="watcher-receipt"
      style={{ "--motion-index": Math.min(motionIndex, 5) } as CSSProperties}
      {...enterProps(enter, onEntered)}
    >
      <summary>
        <span className="watcher-receipt-mark" aria-hidden="true" />
        <span className="watcher-receipt-summary">{receiptSummary(group)}</span>
        <ChevronRight className="watcher-receipt-chevron" size={14} aria-hidden="true" />
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
  enter,
  onEntered,
}: {
  item: WatcherFeedEntry;
  motionIndex: number;
  enter: boolean;
  onEntered: () => void;
}): React.JSX.Element {
  const running = item.state !== "settled";
  return (
    <div
      className="watcher-receipt is-notice"
      data-outcome={item.outcome ?? "running"}
      style={{ "--motion-index": Math.min(motionIndex, 5) } as CSSProperties}
      {...enterProps(enter, onEntered)}
    >
      <span className="watcher-receipt-mark" aria-hidden="true" />
      <span className="watcher-notice-line">
        <strong>{running ? `Check ${item.sequence} · checking now` : watcherOutcomeText(item.outcome)}</strong>
        {!running && <WatcherCheckLine item={item} />}
      </span>
    </div>
  );
}
