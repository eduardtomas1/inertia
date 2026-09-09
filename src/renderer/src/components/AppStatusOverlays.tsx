import { lazy, Suspense, type ComponentProps } from "react";
import { AlertCircle, X } from "lucide-react";
import type { DatabaseRecoveryStartupNotice } from "@shared/desktop";

import type { useAppUpdate } from "../hooks/useAppUpdate";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { ProviderQuotaNoticeController } from "../hooks/useProviderQuotaNotices";
import { ProviderQuotaNotices } from "./ProviderQuotaNotices";
import { IconButton } from "./ui";
import { loadProviderAuthDialog } from "./lazySurfaceLoaders";
import { diagnosticErrorReference, navigateDiagnosticContext } from "../utils/diagnosticNavigation";

const ProviderAuthDialog = lazy(async () => ({
  default: (await loadProviderAuthDialog()).ProviderAuthDialog,
}));
const AppUpdateNotice = lazy(async () => ({
  default: (await import("./AppUpdateNotice")).AppUpdateNotice,
}));
const DatabaseRecoveryNotice = lazy(async () => ({
  default: (await import("./DatabaseRecoveryNotice")).DatabaseRecoveryNotice,
}));

interface AppStatusOverlaysProps {
  providerAuth: ComponentProps<typeof ProviderAuthDialog>;
  appUpdate: ReturnType<typeof useAppUpdate>;
  providerQuotaNotices: ProviderQuotaNoticeController;
  error: string | null;
  onDismissError: () => void;
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
  onDismissError,
  databaseRecoveryNotice,
  onDismissDatabaseRecoveryNotice,
  onImportRecovery,
  onCopyRecoveryReport,
}: AppStatusOverlaysProps): React.JSX.Element {
  const diagnosticError = error ? diagnosticErrorReference(error) : null;
  // Own preview suspension from this always-loaded boundary. The credential
  // dialog itself remains lazy, so waiting for its chunk would briefly leave
  // native preview content above the trusted authentication flow.
  useNativePreviewSuspension(Boolean(
    providerAuth.provider
      || databaseRecoveryNotice
      || appUpdate.visible
      || appUpdate.error
      || providerQuotaNotices.notices.length > 0
      || error,
  ));
  return (
    <>
      {providerAuth.provider && (
        <Suspense fallback={null}>
          <ProviderAuthDialog {...providerAuth} />
        </Suspense>
      )}
      {databaseRecoveryNotice && (
        <Suspense fallback={(
          <aside
            className={`database-recovery-notice${databaseRecoveryNotice.outcome === "created-empty" ? " is-critical" : ""}`}
            aria-label="Database recovery warning"
            role="alert"
          >
            <AlertCircle size={17} aria-hidden="true" />
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
      {(appUpdate.visible || appUpdate.error || providerQuotaNotices.notices.length > 0 || error) && (
        <div className="status-overlay-stack">
          {appUpdate.visible && appUpdate.status && (
            <Suspense fallback={null}>
              <AppUpdateNotice
                status={appUpdate.status}
                onDismiss={appUpdate.dismiss}
                onOpenRelease={() => {
                  void appUpdate.openRelease().catch(() => undefined);
                }}
                onDownload={() => {
                  void appUpdate.download().catch(() => undefined);
                }}
                onCancelDownload={() => {
                  void appUpdate.cancelDownload().catch(() => undefined);
                }}
                onInstall={() => {
                  void appUpdate.install().catch(() => undefined);
                }}
              />
            </Suspense>
          )}
          <ProviderQuotaNotices
            notices={providerQuotaNotices.notices}
            stacked
            onDismiss={providerQuotaNotices.dismiss}
          />
          {appUpdate.error && (
            <div className="error-toast" role="alert">
              <AlertCircle size={17} />
              <span>{appUpdate.error}</span>
              <IconButton label="Dismiss update error" onClick={appUpdate.dismissError}>
                <X size={15} />
              </IconButton>
            </div>
          )}
          {error && (
            <div className="error-toast" role="alert">
              <AlertCircle size={17} />
              <span>{diagnosticError?.message}</span>
              {diagnosticError?.incidentId && <button type="button" className="text-button" onClick={() => navigateDiagnosticContext({ section: "diagnostics", selection: { incidentId: diagnosticError.incidentId } })}>View diagnostics</button>}
              <IconButton label="Dismiss error" onClick={onDismissError}>
                <X size={15} />
              </IconButton>
            </div>
          )}
        </div>
      )}
    </>
  );
}
