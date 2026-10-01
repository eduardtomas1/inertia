import { lazy, Suspense, useState, type RefObject } from "react";
import { ShieldCheck } from "lucide-react";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import type { PendingModelRoute } from "./types";
import type { ConversationContextCommandRunner } from "../conversation-context/types";
import "./RouteChangeConfirmation.css";
const ProviderContinuationDialog = lazy(() => import("./ProviderContinuationDialog"));

const accessLabels = { supervised: "Supervised", "auto-edit": "Auto-accept edits", full: "Full access" } as const;

export interface RouteChangeConfirmationProps {
  pendingRoute: PendingModelRoute;
  creating: boolean;
  cancelRef: RefObject<HTMLButtonElement | null>;
  canCreate: boolean;
  blockedReason?: string | null;
  onDismiss: () => void;
  onCreate: (continuation?: { sourceMessageIds: string[]; instruction: string }) => void;
  onContextCommand?: ConversationContextCommandRunner;
}

export function RouteChangeConfirmation({
  pendingRoute,
  creating,
  cancelRef,
  canCreate,
  blockedReason = null,
  onDismiss,
  onCreate,
  onContextCommand,
}: RouteChangeConfirmationProps): React.JSX.Element {
  const [continuing, setContinuing] = useState(false);
  useNativePreviewSuspension(true);
  return (
    <><div
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
        <small id="route-confirmation-reason">
          {pendingRoute.reason} New chat settings: {accessLabels[pendingRoute.configuration.accessMode]}
          {" · "}{pendingRoute.configuration.interactionMode === "plan" ? "Plan" : "Build"}.
        </small>
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
      {onContextCommand && pendingRoute.sourceUpdatedAt && pendingRoute.continuationConversationId && <button
        type="button" className="secondary-button" disabled={!canCreate || creating}
        onClick={() => setContinuing(true)}
      >Continue with context…</button>}
      <button
        type="button"
        className="primary-button"
        disabled={!canCreate}
        aria-disabled={creating || undefined}
        onClick={() => { if (!creating) onCreate(); }}
      >
        {creating ? "Creating…" : "New chat"}
      </button>
    </div>
      {continuing && onContextCommand && <Suspense fallback={null}>
        <ProviderContinuationDialog pendingRoute={pendingRoute} busy={creating}
          disabled={!canCreate} error={blockedReason} onCommand={onContextCommand}
          onClose={() => setContinuing(false)} onContinue={onCreate} />
      </Suspense>}
    </>
  );
}
