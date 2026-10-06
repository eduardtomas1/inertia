import type { ComposerPrimaryActionState } from "../../utils/composerPrimaryAction";

export function ComposerSendActionsFallback({
  primaryAction,
  onSubmit,
  onStop,
  newChatReasonId,
}: {
  primaryAction: ComposerPrimaryActionState;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
  newChatReasonId?: string;
}): React.JSX.Element {
  const stopping = primaryAction === "stop-pending";
  const stopAndSend = primaryAction === "stop-and-send";
  const stop = primaryAction === "stop-ready" || stopping;
  const submitting = primaryAction === "submitting";
  const primaryLabel = stopAndSend
    ? "Stop and send"
    : stop
    ? stopping ? "Stopping agent" : "Stop agent"
    : submitting ? "Sending message" : newChatReasonId ? "Start a new chat" : "Send message";
  return (
    <button
        type="button"
        aria-label={primaryLabel}
        title={primaryLabel}
        className={`icon-button send-button${stop || stopAndSend ? " stop-button" : ""}${
          submitting ? " send-button-loading" : ""
        }`}
        data-composer-action-state={primaryAction}
        aria-busy={stopping || submitting}
        aria-describedby={stop || stopAndSend ? undefined : newChatReasonId}
        onClick={() => void (stop ? onStop() : onSubmit())}
        disabled={stopping || submitting || (primaryAction === "send-disabled" && !newChatReasonId)}
      >
        <span aria-hidden="true">{stop || stopAndSend ? "■" : submitting ? "…" : "↑"}</span>
    </button>
  );
}
