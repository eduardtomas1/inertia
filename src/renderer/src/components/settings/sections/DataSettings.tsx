import { useEffect, useState } from "react";
import { Download, Import } from "lucide-react";

import type {
  AppSettings,
  Conversation,
  DatabaseBackupStatus,
  ProviderInfo,
} from "@shared/contracts";
import type { AppHealthSnapshot } from "@shared/desktop";
import { useLoadedSurface } from "../../../hooks/useLoadedSurface";
import type { IssueReportSettingsProps } from "../../IssueReportSettings";
import { StorageStatusSettings } from "../../StorageStatusSettings";
import { loadAttachmentStorageSettings } from "../../settingsSectionLoaders";
import { RestoreDefaults } from "../RestoreDefaults";
import { SettingsSectionFallback } from "../SettingsSectionFallback";
import { SettingActionRow, SettingsGroup } from "../SettingsLayout";
import { useSettingAction } from "../useSettingAction";
import { ArchivedChats } from "./ArchivedChats";
import "./DataSettings.css";

export const APP_HEALTH_SAMPLE_INTERVAL_MS = 10_000;

export interface DataSettingsProps {
  settings: AppSettings;
  disabled: boolean;
  providers: ProviderInfo[];
  archived: Conversation[];
  databaseBackup?: DatabaseBackupStatus;
  onReportCommand?: IssueReportSettingsProps["request"];
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
  onUnarchive: (conversation: Conversation) => void;
  onRestoreDefaults: () => Promise<void>;
}

export function DataSettings({
  settings,
  disabled,
  providers,
  archived,
  databaseBackup,
  onReportCommand,
  onUpdate,
  onUnarchive,
  onRestoreDefaults,
}: DataSettingsProps): React.JSX.Element {
  const AttachmentStorageSettings = useLoadedSurface(loadAttachmentStorageSettings, Boolean(onReportCommand));
  const [appHealth, setAppHealth] = useState<AppHealthSnapshot | null>(null);
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const cache = useSettingAction();
  const recovery = useSettingAction();

  useEffect(() => {
    let active = true;
    const sample = async (): Promise<void> => {
      try {
        const health = await window.inertia.getAppHealth();
        if (active) {
          setAppHealth(health);
          setHealthUnavailable(false);
        }
      } catch {
        if (active) setHealthUnavailable(true);
      }
    };
    void sample();
    const timer = window.setInterval(() => { void sample(); }, APP_HEALTH_SAMPLE_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const clearAppCache = async (): Promise<void> => {
    setHealthUnavailable(false);
    await cache.run(async () => {
      const health = await window.inertia.clearAppCache();
      setAppHealth(health);
      return health;
    }, {
      key: "clear-cache",
      exclusive: true,
      success: (health) => health.warnings.some(({ code }) => code === "cache-clear")
        ? "Some browser caches could not be cleared; user data was unchanged."
        : "Browser cache cleared; user data was unchanged.",
      failure: "The browser cache could not be cleared.",
    });
  };

  const recoveryUnavailable = disabled || recovery.busy;

  const exportRecoveryData = (): void => {
    if (recoveryUnavailable) return;
    void recovery.run(() => window.inertia.exportRecoveryData(), {
      key: "export",
      exclusive: true,
      success: (result) => result.status === "exported"
        ? "Recovery file exported. Attachments, credentials, provider sessions, and vault data were excluded."
        : "Recovery export cancelled.",
      failure: "The recovery file could not be exported.",
    });
  };

  const importRecoveryData = (): void => {
    if (recoveryUnavailable) return;
    void recovery.run(() => window.inertia.importRecoveryData(), {
      key: "import",
      exclusive: true,
      success: (result) => result.status === "imported"
        ? result.summary.alreadyImported
          ? "That recovery file was already imported into the authorized folder; no data was duplicated."
          : `Imported ${result.summary.projects} projects, ${result.summary.conversations} conversations, and ${result.summary.messages} messages under new identities with supervised access.`
        : "Recovery import cancelled.",
      failure: "The recovery file was rejected or could not be imported.",
    });
  };

  return (
    <>
      <SettingsGroup title="Storage" headingId="data-heading">
        <StorageStatusSettings
          health={appHealth}
          healthUnavailable={healthUnavailable}
          clearingCache={cache.busy}
          clearCacheNotice={cache.notice}
          backup={databaseBackup}
          onClearCache={clearAppCache}
        />
        {onReportCommand && (AttachmentStorageSettings
          ? <AttachmentStorageSettings settings={settings} disabled={disabled} request={onReportCommand} onUpdate={onUpdate} />
          : <SettingsSectionFallback />)}
      </SettingsGroup>
      <SettingsGroup title="Export and import" headingId="recovery-heading">
        <SettingActionRow
          id="recovery-export"
          className="runtime-log-setting"
          title="Portable conversation recovery export"
          description="Project paths and messages only. Imports create new supervised identities."
          notice={recovery.notice}
          actions={(
            <>
              <button type="button" className="secondary-button" aria-disabled={recoveryUnavailable || undefined} onClick={exportRecoveryData}><Download size={14} aria-hidden="true" />{recovery.pending === "export" ? "Exporting…" : "Export recovery file"}</button>
              <button type="button" className="secondary-button" aria-disabled={recoveryUnavailable || undefined} onClick={importRecoveryData}><Import size={14} aria-hidden="true" />{recovery.pending === "import" ? "Importing…" : "Import recovery file"}</button>
            </>
          )}
        />
      </SettingsGroup>
      <ArchivedChats archived={archived} providers={providers} disabled={disabled} onUnarchive={onUnarchive} />
      <SettingsGroup title="Defaults" headingId="restore-defaults-heading">
        <RestoreDefaults confirmDestructiveActions={settings.confirmDestructiveActions} disabled={disabled} onRestoreDefaults={onRestoreDefaults} />
      </SettingsGroup>
    </>
  );
}
