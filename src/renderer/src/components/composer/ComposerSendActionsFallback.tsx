import type { ComposerPrimaryActionState } from "../../utils/composerPrimaryAction";

export function ComposerSendActionsFallback({
  primaryAction,
  compactOnReturnMode = null,
  compacting = false,
  awaitingInput = false,
  onSubmit,
  onStop,
  onFocusInput,
}: {
  primaryAction: ComposerPrimaryActionState;
  compactOnReturnMode?: "compact" | "full" | null;
  compacting?: boolean;
  awaitingInput?: boolean;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
  onFocusInput?: () => void;
}): React.JSX.Element {
  const stopping = primaryAction === "stop-pending";
  const stopAndSend = primaryAction === "stop-and-send";
  const stop = primaryAction === "stop-ready" || stopping;
  const submitting = primaryAction === "submitting";
  const resting = primaryAction === "send-disabled" && awaitingInput;
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
        aria-disabled={resting || undefined}
        onClick={() => {
          if (stop) void onStop();
          else if (resting) onFocusInput?.();
          else void onSubmit();
        }}
        disabled={submitting || (primaryAction === "send-disabled" && !resting)}
      >
        <span aria-hidden="true">{stop || stopAndSend ? "■" : submitting ? "…" : "↑"}</span>
    </button>
  );
}
