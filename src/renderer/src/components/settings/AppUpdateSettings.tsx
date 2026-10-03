import { Download, RefreshCw } from "lucide-react";

import type { AppUpdateStatus } from "@shared/desktop";
import { INERTIA_VERSION } from "@shared/version";
import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import { loadCanaryRollbackSetting } from "../settingsSectionLoaders";
import { SettingActionRow, SettingsGroup } from "./SettingsLayout";
import { useSettingAction } from "./useSettingAction";

export interface AppUpdateSettingsProps {
  appUpdateStatus: AppUpdateStatus | null;
  checkingAppUpdate: boolean;
  onCheckAppUpdate: () => Promise<void>;
  onDownloadAppUpdate: () => Promise<void>;
  onCancelAppUpdateDownload: () => Promise<void>;
  onInstallAppUpdate: () => Promise<void>;
  onOpenAppRelease: () => Promise<void>;
}

const BUSY_UPDATE_STATES = ["downloading", "downloaded", "installing"];

export function AppUpdateSettings({
  appUpdateStatus,
  checkingAppUpdate,
  onCheckAppUpdate,
  onDownloadAppUpdate,
  onCancelAppUpdateDownload,
  onInstallAppUpdate,
  onOpenAppRelease,
}: AppUpdateSettingsProps): React.JSX.Element {
  const action = useSettingAction();
  const isCanary = appUpdateStatus?.channel === "canary";
  const CanaryRollbackSetting = useLoadedSurface(loadCanaryRollbackSetting, isCanary);
  const checking = action.pending === "check" || checkingAppUpdate;
  const runUpdateAction = (operation: () => Promise<void>, failure: string): void => {
    void action.run(operation, { key: "update", success: null, failure });
  };
  return (
    <SettingsGroup title="Application updates" description="Update on your schedule, never during active work." icon={Download}>
      <SettingActionRow
        id="app-updates"
        className="application-update-setting"
        title={`${isCanary ? "Inertia Canary" : "Inertia"} · v${INERTIA_VERSION}`}
        details={(
          <small role="status" aria-live="polite" aria-atomic="true">
            {appUpdateStatus?.message ?? "Checks run quietly after launch; downloads and installs remain manual."}
          </small>
        )}
        notice={action.notice}
        actions={(
          <>
            {appUpdateStatus?.state === "available" && (
              <button type="button" className="secondary-button" onClick={() => runUpdateAction(onOpenAppRelease, "The release page could not be opened.")}><Download size={14} />View release</button>
            )}
            {appUpdateStatus?.delivery === "in-app" && ["available", "cancelled", "failed"].includes(appUpdateStatus.state) && (
              <button type="button" className="secondary-button" onClick={() => runUpdateAction(onDownloadAppUpdate, "The update download could not be started.")}><Download size={14} />{appUpdateStatus.state === "available" ? "Download" : "Retry download"}</button>
            )}
            {appUpdateStatus?.state === "downloading" && (
              <button type="button" className="secondary-button" onClick={() => runUpdateAction(onCancelAppUpdateDownload, "The update download could not be cancelled.")}>Cancel download</button>
            )}
            {appUpdateStatus?.state === "downloaded" && (
              <button type="button" className="secondary-button" onClick={() => runUpdateAction(onInstallAppUpdate, "The update restart could not be started safely.")}>Restart to update</button>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={checking || BUSY_UPDATE_STATES.includes(appUpdateStatus?.state ?? "")}
              onClick={() => {
                void action.run(onCheckAppUpdate, {
                  key: "check",
                  exclusive: true,
                  success: null,
                  failure: "The update check could not be completed.",
                });
              }}
            >
              <RefreshCw size={14} />{checking ? "Checking…" : "Check now"}
            </button>
          </>
        )}
      />
      {isCanary && CanaryRollbackSetting && <CanaryRollbackSetting />}
    </SettingsGroup>
  );
}
