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
  const stop = primaryAction === "stop-ready" || stopping;
  const submitting = primaryAction === "submitting";
  const primaryLabel = stop
    ? stopping ? "Stopping agent" : "Stop agent"
    : submitting ? "Sending message" : "Send message";
  return (
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
  );
}
