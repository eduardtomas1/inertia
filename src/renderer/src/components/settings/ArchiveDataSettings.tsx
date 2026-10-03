import { useEffect, useMemo, useState } from "react";
import { ArchiveRestore, Database, Download, ShieldCheck } from "lucide-react";

import type {
  AppSettings,
  Conversation,
  DatabaseBackupStatus,
  ProviderInfo,
  RuntimeLifecycleDiagnosticSnapshot,
} from "@shared/contracts";
import type { AppHealthSnapshot, AppUpdateStatus } from "@shared/desktop";
import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import type { IssueReportSettingsProps } from "../IssueReportSettings";
import { StorageStatusSettings } from "../StorageStatusSettings";
import {
  loadAttachmentStorageSettings,
  loadLifecycleIntegritySettings,
} from "../settingsSectionLoaders";
import { SettingsSectionFallback } from "./SettingsSectionFallback";
import { SettingActionRow, SettingsGroup } from "./SettingsLayout";
import { useSettingAction } from "./useSettingAction";

export const APP_HEALTH_SAMPLE_INTERVAL_MS = 10_000;

export interface ArchiveDataSettingsProps {
  settings: AppSettings;
  disabled: boolean;
  providers: ProviderInfo[];
  archived: Conversation[];
  databaseBackup?: DatabaseBackupStatus;
  lifecycleDiagnostics?: RuntimeLifecycleDiagnosticSnapshot;
  appUpdateStatus: AppUpdateStatus | null;
  onReportCommand?: IssueReportSettingsProps["request"];
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
  onUnarchive: (conversation: Conversation) => void;
  onRevealRuntimeLogs: () => Promise<string>;
  onCopyRuntimeDiagnosticReport: () => Promise<{ copied: boolean; eventCount: number }>;
}

export function ArchiveDataSettings({
  settings,
  disabled,
  providers,
  archived,
  databaseBackup,
  lifecycleDiagnostics,
  appUpdateStatus,
  onReportCommand,
  onUpdate,
  onUnarchive,
  onRevealRuntimeLogs,
  onCopyRuntimeDiagnosticReport,
}: ArchiveDataSettingsProps): React.JSX.Element {
  const AttachmentStorageSettings = useLoadedSurface(loadAttachmentStorageSettings, Boolean(onReportCommand));
  const LifecycleIntegritySettings = useLoadedSurface(loadLifecycleIntegritySettings, true);
  const providerLabels = useMemo(() => new Map(providers.map((provider) => [provider.id, provider.label])), [providers]);
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

  const exportRecoveryData = (): void => {
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
      <SettingsGroup title="Archived threads" description="Restore work with its original context." icon={ArchiveRestore}>
        <div data-setting-id="archived-threads">
          {archived.length > 0 ? (
            <div className="archive-list">
              {archived.map((thread) => (
                <div className="archive-row" key={thread.id}>
                  <span>
                    <strong>{thread.title}</strong>
                    <small>{providerLabels.get(thread.providerId) ?? thread.providerId}</small>
                  </span>
                  <button type="button" className="secondary-button" disabled={disabled} onClick={() => onUnarchive(thread)}>
                    <ArchiveRestore size={14} />Restore
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="settings-empty-state">
              <ArchiveRestore size={19} />
              <strong>No archived threads</strong>
              <span>Archived work will appear here.</span>
            </div>
          )}
        </div>
      </SettingsGroup>
      <SettingsGroup title="Local data" description="Database backups and portable recovery exports." icon={Database}>
        <div className="settings-data-note"><ShieldCheck size={17} /><span><strong>Provider credentials stay outside Inertia.</strong><small>Account authentication remains in each provider’s own secure storage.</small></span></div>
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
        <SettingActionRow
          id="recovery-export"
          className="runtime-log-setting"
          title="Portable conversation recovery export"
          description="Exports project paths and messages without presets, attachments, sessions, execution context, Git artifacts, credentials, secret references, or vault data. Imports create new supervised identities."
          notice={recovery.notice}
          actions={(
            <>
              <button type="button" className="secondary-button" disabled={disabled || recovery.busy} onClick={exportRecoveryData}><Download size={14} />{recovery.pending === "export" ? "Exporting…" : "Export recovery file"}</button>
              <button type="button" className="secondary-button" disabled={disabled || recovery.busy} onClick={importRecoveryData}><ArchiveRestore size={14} />{recovery.pending === "import" ? "Importing…" : "Import recovery file"}</button>
            </>
          )}
        />
        {LifecycleIntegritySettings && (
          <LifecycleIntegritySettings
            surface="runtime-diagnostics"
            diagnostics={lifecycleDiagnostics}
            appUpdateStatus={appUpdateStatus}
            onRevealRuntimeLogs={onRevealRuntimeLogs}
            onCopyRuntimeDiagnosticReport={onCopyRuntimeDiagnosticReport}
          />
        )}
      </SettingsGroup>
    </>
  );
}
