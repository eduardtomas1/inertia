import { lazy, Suspense, type ComponentProps } from "react";
import { AlertCircle, X } from "lucide-react";

import type { useAppUpdate } from "../hooks/useAppUpdate";
import type { ProviderQuotaNoticeController } from "../hooks/useProviderQuotaNotices";
import { AppUpdateNotice } from "./AppUpdateNotice";
import { ProviderQuotaNotices } from "./ProviderQuotaNotices";
import { IconButton } from "./ui";

const ProviderAuthDialog = lazy(async () => ({
  default: (await import("./ProviderAuthDialog")).ProviderAuthDialog,
}));

interface AppStatusOverlaysProps {
  providerAuth: ComponentProps<typeof ProviderAuthDialog>;
  appUpdate: ReturnType<typeof useAppUpdate>;
  providerQuotaNotices: ProviderQuotaNoticeController;
  error: string | null;
  onDismissError: () => void;
}

export function AppStatusOverlays({
  providerAuth,
  appUpdate,
  providerQuotaNotices,
  error,
  onDismissError,
}: AppStatusOverlaysProps): React.JSX.Element {
  return (
    <>
      {providerAuth.provider && (
        <Suspense fallback={null}>
          <ProviderAuthDialog {...providerAuth} />
        </Suspense>
      )}
      {appUpdate.visible && appUpdate.status && (
        <AppUpdateNotice
          status={appUpdate.status}
          onDismiss={appUpdate.dismiss}
          onOpenRelease={() => {
            void appUpdate.openRelease().catch(() => undefined);
          }}
        />
      )}
      <ProviderQuotaNotices
        notices={providerQuotaNotices.notices}
        bottomOffset={20
          + (appUpdate.visible && appUpdate.status ? 64 : 0)
          + (error ? 58 : 0)}
        onDismiss={providerQuotaNotices.dismiss}
      />
      {error && (
        <div className="error-toast" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
          <IconButton label="Dismiss error" onClick={onDismissError}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </>
  );
}
