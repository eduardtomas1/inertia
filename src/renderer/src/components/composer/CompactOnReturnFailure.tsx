import { CircleAlert } from "lucide-react";

export function CompactOnReturnFailure({
  message,
  disabled,
  onSendWithoutCompacting,
  onTryAgain,
}: {
  message: string;
  disabled: boolean;
  onSendWithoutCompacting: () => void;
  onTryAgain: () => void;
}): React.JSX.Element {
  return (
    <div className="composer-compact-failure" role="alert">
      <CircleAlert size={14} aria-hidden="true" />
      <span>{message}</span>
      <span className="composer-compact-failure-actions">
        <button type="button" className="composer-compact-failure-action" disabled={disabled} onClick={onSendWithoutCompacting}>
          Send without compacting
        </button>
        <button type="button" className="composer-compact-failure-action" disabled={disabled} onClick={onTryAgain}>
          Try again
        </button>
      </span>
    </div>
  );
}
