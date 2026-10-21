import type { CSSProperties } from "react";
import { ChevronRight } from "lucide-react";

import type { WatcherFeedItem } from "@shared/watcher";
import type { WatcherReceiptGroup as ReceiptGroup } from "@shared/watcher-feed";
import { formatBytes } from "../../utils/formatBytes";
import {
  watcherClockTime,
  watcherDigestNote,
  watcherOutcomeText,
  watcherTriggerText,
} from "../../utils/watcherCopy";
import { watcherEventsText } from "../../utils/watcherLinks";

function guardNote(item: WatcherFeedItem): string | null {
  if (item.guardState === "inconclusive") {
    return item.guardPaths.length > 0
      ? `files changed during this check: ${item.guardPaths.join(", ")}`
      : "the checkout changed during this check";
  }
  if (item.guardState === "unavailable") return "no Git fingerprint for this checkout";
  return null;
}

function sentNote(item: WatcherFeedItem): string | null {
  return item.digestBytes !== undefined && item.digestBytes > 0
    ? `${formatBytes(item.digestBytes)} sent`
    : null;
}

function commandsNote(count: number | null | undefined): string | null {
  if (typeof count !== "number" || count <= 0) return null;
  return `ran ${count} read-only ${count === 1 ? "command" : "commands"}`;
}

function declinedNote(declined: number, ran: string | null): string | null {
  if (declined <= 0) return null;
  if (ran) return `${declined} declined`;
  return `${declined} ${declined === 1 ? "command" : "commands"} declined`;
}

function commandNotes(ran: number | null | undefined, declined: number): string[] {
  const commands = commandsNote(ran);
  return [commands, declinedNote(declined, commands)].filter((note): note is string => Boolean(note));
}

function WatcherCheckLine({ item }: { item: WatcherFeedItem }): React.JSX.Element {
  const notes = [
    watcherTriggerText(item.trigger),
    watcherEventsText(item.eventsCovered),
    ...commandNotes(item.commandsRun, item.commandsDeclined),
    watcherDigestNote(item),
    sentNote(item),
    guardNote(item),
  ].filter((note): note is string => Boolean(note));
  return (
    <span className="watcher-check-line">
      <span className="watcher-check-title">
        Check {item.sequence} ·{" "}
        <time dateTime={item.settledAt ?? item.createdAt}>{watcherClockTime(item.settledAt ?? item.createdAt)}</time>
      </span>
      <span className="watcher-check-notes">{notes.join(" · ")}</span>
    </span>
  );
}

function receiptTimes(group: ReceiptGroup): string {
  const first = watcherClockTime(group.firstAt);
  const last = watcherClockTime(group.lastAt);
  if (group.count === 1 || !last || first === last) return first;
  const [firstClock, firstPeriod] = first.split(/\s/u);
  const [, lastPeriod] = last.split(/\s/u);
  return `${firstPeriod && firstPeriod === lastPeriod ? firstClock : first}–${last}`;
}

function receiptSummary(group: ReceiptGroup): string {
  const times = group.count === 1 ? "once" : `${group.count} times`;
  const declined = group.items.reduce((sum, { commandsDeclined }) => sum + commandsDeclined, 0);
  return [`Checked ${times}`, receiptTimes(group), "nothing to report", ...commandNotes(group.commandsRun, declined)].join(" · ");
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

export function WatcherNoticeLine({
  item,
  motionIndex,
  enter,
  onEntered,
}: {
  item: WatcherFeedItem;
  motionIndex: number;
  enter: boolean;
  onEntered: () => void;
}): React.JSX.Element {
  const { outcome } = item;
  return (
    <div
      className="watcher-receipt is-notice"
      data-outcome={outcome ?? "running"}
      style={{ "--motion-index": Math.min(motionIndex, 5) } as CSSProperties}
      {...enterProps(enter, onEntered)}
    >
      <span className="watcher-notice-line">
        <span className="watcher-notice-line-title">{outcome === null ? `Check ${item.sequence}` : watcherOutcomeText(outcome)}</span>
        {outcome !== null && <WatcherCheckLine item={item} />}
      </span>
    </div>
  );
}
