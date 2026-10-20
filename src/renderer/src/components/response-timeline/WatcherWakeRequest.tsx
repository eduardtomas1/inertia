import type { ResponseTurn } from "../../utils/response-timeline/model";
import {
  watcherEventsText,
  watcherOutcomeText,
  watcherTriggerText,
} from "../../utils/watcherCopy";
import "./WatcherRows.css";

/**
 * In a watcher's own chat, each check's request is the digest Inertia sent.
 * It renders as one compact "Check N · K events" row; the digest itself stays
 * behind "What the watcher was shown".
 */
export function WatcherWakeRequest({ turn }: { turn: ResponseTurn }): React.JSX.Element | null {
  const wake = turn.watcherWake;
  if (!wake) return null;
  const title = `Check ${wake.sequence} · ${watcherEventsText(wake.eventsCovered)}`;
  const omitted = wake.itemsTruncated + wake.itemsOmitted > 0
    ? [
        wake.itemsTruncated > 0 ? `${wake.itemsTruncated} shortened` : null,
        wake.itemsOmitted > 0 ? `${wake.itemsOmitted} left out` : null,
      ].filter(Boolean).join(" · ")
    : null;
  return (
    <article
      className="turn-user-request watcher-wake-request"
      aria-label={title}
      data-turn-layer="user-request"
      data-turn-request-context={turn.id}
      data-turn-jump-target="request"
      data-message-search-id={turn.userMessage.id}
      tabIndex={-1}
    >
      <p className="watcher-wake-row">
        <span className="watcher-wake-mark" aria-hidden="true" />
        <strong>{title}</strong>
        <span>{watcherTriggerText(wake.trigger)}</span>
        {wake.outcome && <span>{watcherOutcomeText(wake.outcome)}</span>}
        {omitted && <span>{omitted}</span>}
      </p>
      <details className="watcher-wake-digest">
        <summary>What the watcher was shown</summary>
        <pre>{turn.userMessage.content}</pre>
      </details>
    </article>
  );
}
