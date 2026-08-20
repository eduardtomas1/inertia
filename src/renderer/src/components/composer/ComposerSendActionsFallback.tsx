import type {
  ComposerFollowUpState,
  ComposerPrimaryActionState,
} from "../../utils/composerPrimaryAction";

export function ComposerSendActionsFallback({
  followUpState,
  primaryAction,
  onSubmit,
  onStop,
}: {
  followUpState: ComposerFollowUpState;
  primaryAction: ComposerPrimaryActionState;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
}): React.JSX.Element {
  const followUpPending = followUpState === "pending";
  const stopping = primaryAction === "stop-pending";
  const stop = primaryAction === "stop-ready" || stopping;
  const submitting = primaryAction === "submitting";
  const primaryLabel = stop
    ? stopping ? "Stopping agent" : "Stop agent"
    : submitting ? "Sending message" : "Send message";
  return (
    <>
      {followUpState === "ready" || followUpPending ? (
        <button
          type="button"
          className="secondary-button composer-follow-up-button"
          aria-label={followUpPending ? "Sending follow-up" : "Send follow-up"}
          aria-busy={followUpPending}
          disabled={followUpPending}
          onClick={() => void onSubmit()}
        >
          <span aria-hidden="true">{followUpPending ? "…" : "↑"}</span>
          <span>{followUpPending ? "Sending…" : "Follow up"}</span>
        </button>
      ) : null}
      <button
        type="button"
        aria-label={primaryLabel}
        title={primaryLabel}
        className={`icon-button send-button${stop ? " stop-button" : ""}${
          submitting ? " send-button-loading" : ""
        }`}
        data-composer-action-state={primaryAction}
        aria-busy={stopping || submitting}
        onClick={() => void (stop ? onStop() : onSubmit())}
        disabled={stopping || submitting || primaryAction === "send-disabled"}
      >
        <span aria-hidden="true">{stop ? "■" : submitting ? "…" : "↑"}</span>
      </button>
    </>
  );
}
