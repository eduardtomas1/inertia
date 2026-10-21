import type { ResponseTurn } from "../../utils/response-timeline/model";
import {
  watcherDigestNote,
  watcherOutcomeText,
  watcherTriggerText,
} from "../../utils/watcherCopy";
import { watcherCheckTitle } from "../../utils/watcherLinks";
import { useAnchoredDetailsToggle } from "./activity";
import "./WatcherRows.css";

export function WatcherWakeRequest({
  turn,
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element | null {
  const anchorToggleHandlers = useAnchoredDetailsToggle(onBeforeToggle, onAfterToggle);
  const wake = turn.watcherWake;
  if (!wake) return null;
  const title = watcherCheckTitle(wake);
  const omitted = watcherDigestNote(wake);
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
        <strong>{title}</strong>
        <span>{watcherTriggerText(wake.trigger)}</span>
        {wake.outcome && <span>{watcherOutcomeText(wake.outcome).replace(/\.$/u, "")}</span>}
        {omitted && <span>{omitted}</span>}
      </p>
      <details className="watcher-wake-digest">
        <summary {...anchorToggleHandlers}>What the watcher was shown</summary>
        <pre>{turn.userMessage.content}</pre>
      </details>
    </article>
  );
}
