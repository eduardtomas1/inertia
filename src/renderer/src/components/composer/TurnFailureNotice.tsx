import { CircleAlert } from "lucide-react";

import type { TurnFailureAction, TurnFailureGuidance } from "../../utils/turnFailureGuidance";

export function TurnFailureNotice({
  guidance,
  disabled,
  onAction,
}: {
  guidance: TurnFailureGuidance;
  disabled: boolean;
  onAction: (action: TurnFailureAction) => void;
}): React.JSX.Element {
  return (
    <div className="limit-reset turn-failure-notice" role="group" aria-label="Route problem" data-state="limited">
      <CircleAlert className="limit-reset-icon" size={14} aria-hidden="true" />
      <span className="limit-reset-copy">
        <strong>{guidance.title}</strong>
        <span>{guidance.detail}</span>
      </span>
      {guidance.action && (
        <span className="limit-reset-actions">
          <button
            type="button"
            aria-disabled={disabled || undefined}
            onClick={() => { if (!disabled && guidance.action) onAction(guidance.action); }}
          >
            {guidance.action.label}
          </button>
        </span>
      )}
    </div>
  );
}
