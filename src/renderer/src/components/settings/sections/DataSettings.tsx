import { useEffect, useRef, useState } from "react";
import { Download, Import } from "lucide-react";

import type {
  AppSettings,
  Conversation,
  DatabaseBackupStatus,
  ProviderInfo,
} from "@shared/contracts";
import type { DatabaseCompactionSummary, DatabaseStorageStatus } from "@shared/database-storage";
import type { AppHealthSnapshot } from "@shared/desktop";
import { useLoadedSurface } from "../../../hooks/useLoadedSurface";
import { formatBytes } from "../../../utils/formatBytes";
import type { IssueReportSettingsProps } from "../../IssueReportSettings";
import { StorageStatusSettings } from "../../StorageStatusSettings";
import { loadAttachmentStorageSettings } from "../../settingsSectionLoaders";
import { RestoreDefaults } from "../RestoreDefaults";
import { SettingsSectionFallback } from "../SettingsSectionFallback";
import { SettingActionRow, SettingsGroup } from "../SettingsLayout";
import { useSettingAction } from "../useSettingAction";
import { AgentSecretsSettings } from "./AgentSecretsSettings";
import { ArchivedChats } from "./ArchivedChats";
import "./DataSettings.css";

export const APP_HEALTH_SAMPLE_INTERVAL_MS = 10_000;
const DATABASE_COMPACTION_POLL_INTERVAL_MS = 500;

function formatCompactionResult(compaction: DatabaseCompactionSummary | null): string {
  if (!compaction) return "Database compaction finished.";
  if (compaction.reclaimedBytes > 0) {
    return `Compacted database and reclaimed ${formatBytes(compaction.reclaimedBytes)}.`;
  }
  if (
    compaction.mode === "full-vacuum"
    && compaction.autoVacuumBefore !== "incremental"
    && compaction.autoVacuumAfter === "incremental"
  ) {
    return "Database compacted and enabled incremental space reclamation (0 B reclaimed).";
  }
  return "Database is already compact (0 B reclaimed).";
}

export interface DataSettingsProps {
  settings: AppSettings;
  disabled: boolean;
  providers: ProviderInfo[];
  archived: Conversation[];
  databaseBackup?: DatabaseBackupStatus;
  hasActiveTurns?: boolean;
  onReportCommand?: IssueReportSettingsProps["request"];
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
  onUnarchive: (conversation: Conversation) => void;
  onOpenConversation?: (conversationId: string) => boolean;
  onRestoreDefaults: () => Promise<void>;
}

export function DataSettings({
  settings,
  disabled,
  providers,
  archived,
  databaseBackup,
  hasActiveTurns = false,
  onReportCommand,
  onUpdate,
  onUnarchive,
  onOpenConversation,
  onRestoreDefaults,
}: DataSettingsProps): React.JSX.Element {
  const AttachmentStorageSettings = useLoadedSurface(loadAttachmentStorageSettings, Boolean(onReportCommand));
  const [appHealth, setAppHealth] = useState<AppHealthSnapshot | null>(null);
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [databaseStorage, setDatabaseStorage] = useState<DatabaseStorageStatus | null>(null);
  const [databaseStorageUnavailable, setDatabaseStorageUnavailable] = useState(!onReportCommand);
  const cache = useSettingAction();
  const compact = useSettingAction();
  const recovery = useSettingAction();
  const requestRef = useRef(onReportCommand);
  requestRef.current = onReportCommand;
  const hasRequestChannel = Boolean(onReportCommand);

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

  useEffect(() => {
    if (!hasRequestChannel) {
      setDatabaseStorageUnavailable(true);
      return;
    }
    let active = true;
    const sampleDatabaseStorage = async (): Promise<void> => {
      const request = requestRef.current;
      if (!request) return;
      try {
        const event = await request({ type: "database.storage.get" });
        if (!active) return;
        if (event.type === "request.result" && event.result.kind === "database.storage") {
          setDatabaseStorage(event.result.storage);
          setDatabaseStorageUnavailable(false);
        } else {
          setDatabaseStorageUnavailable(true);
        }
      } catch {
        if (active) setDatabaseStorageUnavailable(true);
      }
    };
    void sampleDatabaseStorage();
    const timer = window.setInterval(() => { void sampleDatabaseStorage(); }, APP_HEALTH_SAMPLE_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hasRequestChannel, databaseBackup?.lastValidatedAt]);

  const pollingCompaction = compact.busy || databaseStorage?.busy === true;
  useEffect(() => {
    if (!hasRequestChannel || !pollingCompaction) return;
    let active = true;
    const timer = window.setInterval(() => {
      const request = requestRef.current;
      if (!request) return;
      void request({ type: "database.storage.get" }).then((event) => {
        if (active && event.type === "request.result" && event.result.kind === "database.storage") {
          setDatabaseStorage(event.result.storage);
          setDatabaseStorageUnavailable(false);
        }
      }).catch(() => undefined);
    }, DATABASE_COMPACTION_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hasRequestChannel, pollingCompaction]);

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

  const compactDatabase = async (): Promise<void> => {
    const request = requestRef.current;
    if (!request) return;
    await compact.run(async () => {
      const event = await request({ type: "database.storage.compact" });
      if (event.type !== "request.result" || event.result.kind !== "database.storage") {
        throw new Error("Database storage result unavailable.");
      }
      setDatabaseStorage(event.result.storage);
      setDatabaseStorageUnavailable(false);
      void window.inertia.getAppHealth().then((health) => {
        setAppHealth(health);
        setHealthUnavailable(false);
      }).catch(() => undefined);
      return event.result.compaction ?? null;
    }, {
      key: "compact-database",
      exclusive: true,
      success: (compaction) => formatCompactionResult(compaction),
      failure: (error) => error instanceof Error && error.message.trim()
        ? error.message
        : "The database could not be compacted.",
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
          databaseStorage={databaseStorage}
          databaseStorageUnavailable={databaseStorageUnavailable}
          compactingDatabase={compact.busy}
          compactDatabaseNotice={compact.notice}
          hasActiveTurns={hasActiveTurns}
          disabled={disabled}
          onClearCache={clearAppCache}
          onCompactDatabase={onReportCommand ? compactDatabase : undefined}
        />
        {onReportCommand && (AttachmentStorageSettings
          ? <AttachmentStorageSettings settings={settings} disabled={disabled} request={onReportCommand} onUpdate={onUpdate} />
          : <SettingsSectionFallback />)}
      </SettingsGroup>
      {onReportCommand && <AgentSecretsSettings disabled={disabled} request={onReportCommand} onOpenConversation={onOpenConversation} />}
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
