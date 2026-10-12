import type { ComposerPrimaryActionState } from "../../utils/composerPrimaryAction";

export function ComposerSendActionsFallback({
  primaryAction,
  onSubmit,
  onStop,
}: {
  primaryAction: ComposerPrimaryActionState;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
}): React.JSX.Element {
  const stopping = primaryAction === "stop-pending";
  const stopAndSend = primaryAction === "stop-and-send";
  const stop = primaryAction === "stop-ready" || stopping;
  const submitting = primaryAction === "submitting";
  const primaryLabel = stopAndSend
    ? "Stop and send"
    : stop
    ? stopping ? "Stopping agent" : "Stop agent"
    : submitting ? "Sending message" : "Send message";
  return (
    <button
        type="button"
        aria-label={primaryLabel}
        className={`icon-button send-button${stop || stopAndSend ? " stop-button" : ""}${
          submitting ? " send-button-loading" : ""
        }`}
        data-composer-action-state={primaryAction}
        aria-busy={stopping || submitting}
        onClick={() => void (stop ? onStop() : onSubmit())}
        disabled={stopping || submitting || primaryAction === "send-disabled"}
      >
        <span aria-hidden="true">{stop || stopAndSend ? "■" : submitting ? "…" : "↑"}</span>
    </button>
  );
}
