import { lazy, Suspense, type ComponentProps } from "react";
import { AlertCircle, X } from "lucide-react";
import type { DatabaseRecoveryStartupNotice } from "@shared/desktop";

import type { useAppUpdate } from "../hooks/useAppUpdate";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { ProviderQuotaNoticeController } from "../hooks/useProviderQuotaNotices";
import { AppUpdateNotice } from "./AppUpdateNotice";
import { DatabaseRecoveryNotice } from "./DatabaseRecoveryNotice";
import { ProviderQuotaNotices } from "./ProviderQuotaNotices";
import { IconButton } from "./ui";
import { loadProviderAuthDialog } from "./lazySurfaceLoaders";

const ProviderAuthDialog = lazy(async () => ({
  default: (await loadProviderAuthDialog()).ProviderAuthDialog,
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
        <DatabaseRecoveryNotice
          notice={databaseRecoveryNotice}
          onDismiss={onDismissDatabaseRecoveryNotice}
          onImportRecovery={onImportRecovery}
          onCopyReport={onCopyRecoveryReport}
        />
      )}
      {(appUpdate.visible || appUpdate.error || providerQuotaNotices.notices.length > 0 || error) && (
        <div className="status-overlay-stack">
          {appUpdate.visible && appUpdate.status && (
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
              <span>{error}</span>
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
