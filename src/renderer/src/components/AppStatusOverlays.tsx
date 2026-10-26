import { lazy, Suspense, type ComponentProps } from "react";
import { CircleAlert, Columns2, ShieldAlert, X } from "lucide-react";
import type { DatabaseRecoveryStartupNotice } from "@shared/desktop";

import type { useAppUpdate } from "../hooks/useAppUpdate";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { ProviderQuotaNoticeController } from "../hooks/useProviderQuotaNotices";
import { ProviderQuotaNotices } from "./ProviderQuotaNotices";
import { useDuoJudgeNotices } from "./DuoJudgeNoticeContext";
import { IconButton } from "./ui";
import { loadProviderAuthDialog } from "./lazySurfaceLoaders";
import { diagnosticErrorReference, navigateDiagnosticContext } from "../utils/diagnosticNavigation";

const ProviderAuthDialog = lazy(async () => ({
  default: (await loadProviderAuthDialog()).ProviderAuthDialog,
}));
const DatabaseRecoveryNotice = lazy(async () => ({
  default: (await import("./DatabaseRecoveryNotice")).DatabaseRecoveryNotice,
}));

interface AppStatusOverlaysProps {
  providerAuth: ComponentProps<typeof ProviderAuthDialog>;
  appUpdate: ReturnType<typeof useAppUpdate>;
  providerQuotaNotices: ProviderQuotaNoticeController;
  error: string | null;
  databaseRecoveryNotice: DatabaseRecoveryStartupNotice | null;
}

interface DatabaseRecoveryNoticeProps {
  databaseRecoveryNotice: DatabaseRecoveryStartupNotice | null;
  onDismissDatabaseRecoveryNotice: () => void;
  onImportRecovery: () => Promise<void>;
  onCopyRecoveryReport: () => Promise<void>;
}

export function AppStatusOverlays({
  providerAuth,
  appUpdate,
  providerQuotaNotices,
  error,
  databaseRecoveryNotice,
}: AppStatusOverlaysProps): React.JSX.Element {
  const duoJudgeAlerts = useDuoJudgeNotices()?.alerts.length ?? 0;
  // Own preview suspension from this always-loaded boundary. The credential
  // dialog itself remains lazy, so waiting for its chunk would briefly leave
  // native preview content above the trusted authentication flow.
  useNativePreviewSuspension(Boolean(
    providerAuth.provider
      || databaseRecoveryNotice
      || appUpdate.error
      || providerQuotaNotices.notices.length > 0
      || duoJudgeAlerts > 0
      || error,
  ));
  return (
    <>
      {providerAuth.provider && (
        <Suspense fallback={null}>
          <ProviderAuthDialog {...providerAuth} />
        </Suspense>
      )}
    </>
  );
}

export function StatusToastStack({
  appUpdate,
  providerQuotaNotices,
  error,
  onDismissError,
  databaseRecoveryNotice,
  onDismissDatabaseRecoveryNotice,
  onImportRecovery,
  onCopyRecoveryReport,
}: Pick<AppStatusOverlaysProps, "appUpdate" | "providerQuotaNotices" | "error"> & DatabaseRecoveryNoticeProps & {
  onDismissError: () => void;
}): React.JSX.Element | null {
  const duoJudgeNotices = useDuoJudgeNotices();
  const duoJudgeAlerts = duoJudgeNotices?.alerts ?? [];
  if (!databaseRecoveryNotice && !appUpdate.error && providerQuotaNotices.notices.length === 0 && duoJudgeAlerts.length === 0 && !error) return null;
  const diagnosticError = error ? diagnosticErrorReference(error) : null;
  return (
    <div className="status-overlay-stack">
      {databaseRecoveryNotice && (
        <Suspense fallback={(
          <aside
            className={`database-recovery-notice${databaseRecoveryNotice.outcome === "created-empty" ? " is-critical" : ""}`}
            aria-label="Database recovery warning"
            role="alert"
          >
            <ShieldAlert size={16} aria-hidden="true" />
            <span>
              <strong>{databaseRecoveryNotice.outcome === "created-empty"
                ? "Inertia started with empty data"
                : "Inertia restored a validated backup"}</strong>
              <small>Loading recovery actions…</small>
            </span>
          </aside>
        )}>
          <DatabaseRecoveryNotice
            notice={databaseRecoveryNotice}
            onDismiss={onDismissDatabaseRecoveryNotice}
            onImportRecovery={onImportRecovery}
            onCopyReport={onCopyRecoveryReport}
          />
        </Suspense>
      )}
      <ProviderQuotaNotices
        notices={providerQuotaNotices.notices}
        onDismiss={providerQuotaNotices.dismiss}
      />
      {duoJudgeNotices && duoJudgeAlerts.map(({ launchId, conversationId, title, state }) => (
        <div key={launchId} className="error-toast duo-judge-toast" role="alert">
          <Columns2 size={16} aria-hidden="true" />
          <span>{`${title ? `“${title}”` : "The Duo judge"} ${state === "interrupted" ? "was interrupted." : "didn't finish."}`}</span>
          {conversationId && <button type="button" className="text-button" onClick={() => {
            duoJudgeNotices.dismissAlert(launchId);
            duoJudgeNotices.openJudge(conversationId);
          }}>Open judge</button>}
          <IconButton label="Dismiss Duo judge notice" onClick={() => duoJudgeNotices.dismissAlert(launchId)}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
      {appUpdate.error && (
        <div className="error-toast" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{appUpdate.error}</span>
          <IconButton label="Dismiss update error" onClick={appUpdate.dismissError}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {error && (
        <div className="error-toast" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{diagnosticError?.message}</span>
          {diagnosticError?.incidentId && <button type="button" className="text-button" onClick={() => navigateDiagnosticContext({ section: "help", anchor: "diagnostics-incidents", selection: { incidentId: diagnosticError.incidentId } })}>View diagnostics</button>}
          <IconButton label="Dismiss error" onClick={onDismissError}>
            <X size={14} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
