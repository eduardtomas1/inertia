import type { RefObject } from "react";
import { ShieldCheck } from "lucide-react";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import type { PendingModelRoute } from "./types";

export interface RouteChangeConfirmationProps {
  pendingRoute: PendingModelRoute;
  creating: boolean;
  cancelRef: RefObject<HTMLButtonElement | null>;
  canCreate: boolean;
  blockedReason?: string | null;
  onDismiss: () => void;
  onCreate: () => void;
}

export function RouteChangeConfirmation({
  pendingRoute,
  creating,
  cancelRef,
  canCreate,
  blockedReason = null,
  onDismiss,
  onCreate,
}: RouteChangeConfirmationProps): React.JSX.Element {
  useNativePreviewSuspension(true);
  return (
    <div
      className="composer-route-confirmation"
      role="alertdialog"
      aria-modal="false"
      aria-busy={creating}
      aria-labelledby="route-confirmation-title"
      aria-describedby="route-confirmation-reason"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || creating) return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }}
    >
      <ShieldCheck size={16} aria-hidden="true" />
      <span>
        <strong id="route-confirmation-title">
          Open a new chat for {pendingRoute.label}?
        </strong>
        <small id="route-confirmation-reason">{pendingRoute.reason}</small>
        {blockedReason && <small role="alert">{blockedReason}</small>}
      </span>
      <button
        ref={cancelRef}
        type="button"
        className="secondary-button"
        disabled={creating}
        onClick={onDismiss}
      >
        Cancel
      </button>
      <button
        type="button"
        className="primary-button"
        disabled={!canCreate || creating}
        onClick={onCreate}
      >
        {creating ? "Creating…" : "New chat"}
      </button>
    </div>
  );
}
