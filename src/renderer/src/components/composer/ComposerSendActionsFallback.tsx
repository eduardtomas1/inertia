import type { ComposerPrimaryActionState } from "../../utils/composerPrimaryAction";

export function ComposerSendActionsFallback({
  primaryAction,
  compactOnReturnMode = null,
  compacting = false,
  onSubmit,
  onStop,
}: {
  primaryAction: ComposerPrimaryActionState;
  compactOnReturnMode?: "compact" | "full" | null;
  compacting?: boolean;
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
    : submitting
    ? compacting ? "Compacting before sending" : "Sending message"
    : primaryAction === "send-ready" && compactOnReturnMode
    ? compactOnReturnMode === "compact" ? "Compact and send" : "Send"
    : "Send message";
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
        disabled={submitting || primaryAction === "send-disabled"}
      >
        <span aria-hidden="true">{stop || stopAndSend ? "■" : submitting ? "…" : "↑"}</span>
    </button>
  );
}
