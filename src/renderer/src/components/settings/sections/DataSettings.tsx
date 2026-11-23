import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Download, Import } from "lucide-react";

import type { AttachmentStorageStatus } from "@shared/attachment-storage";
import type {
  AppSettings,
  Conversation,
  DatabaseBackupStatus,
  ProviderInfo,
} from "@shared/contracts";
import type { DatabaseCompactionSummary, DatabaseStorageStatus } from "@shared/database-storage";
import type {
  AppHealthSnapshot,
  DatabaseRecoveryExportResult,
  DatabaseRecoveryImportResult,
} from "@shared/desktop";
import { useLoadedSurface } from "../../../hooks/useLoadedSurface";
import { INTERFACE_LOCALE } from "../../../lib/locale";
import { formatBytes } from "../../../utils/formatBytes";
import type { IssueReportSettingsProps } from "../../IssueReportSettings";
import { StorageStatusSettings } from "../../StorageStatusSettings";
import { loadAttachmentStorageSettings } from "../../settingsSectionLoaders";
import { RestoreDefaults } from "../RestoreDefaults";
import { SettingsSectionFallback } from "../SettingsSectionFallback";
import { SettingActionRow, SettingsGroup } from "../SettingsLayout";
import { useSettingAction } from "../useSettingAction";
import { AgentSecretsSettings } from "./AgentSecretsSettings";
import { ArchivedChats, type ArchivedConversationsLoader } from "./ArchivedChats";
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

function formatRetainedAttachmentEstimate(
  status: AttachmentStorageStatus | null,
  unavailable: boolean,
  hasRequestChannel: boolean,
): string {
  if (!hasRequestChannel || unavailable) {
    return "Retained attachment size estimate is unavailable.";
  }
  if (!status) return "Estimating retained attachments…";
  if (status.state === "reconciling") return "Checking retained attachments after restart…";
  if (status.state !== "ready" || status.records === null || status.bytes === null) {
    return "Retained attachment size estimate is unavailable.";
  }
  if (status.records === 0) return "0 retained attachments (0 B).";
  const count = status.records.toLocaleString(INTERFACE_LOCALE);
  const noun = status.records === 1 ? "attachment" : "attachments";
  return `Retained attachments: ${count} ${noun} (${formatBytes(status.bytes)}).`;
}

function formatRecoveryExportResult(
  result: DatabaseRecoveryExportResult,
  requestedAttachments: boolean,
): string {
  if (result.status !== "exported") return "Recovery export cancelled.";
  const summary = result.summary;
  const includeAttachments = summary?.includeAttachments ?? requestedAttachments;
  if (!includeAttachments) {
    return "Recovery file exported. Attachments, credentials, provider sessions, and vault data were excluded.";
  }
  const included = summary?.attachments ?? 0;
  const missing = summary?.missingAttachments ?? 0;
  const includedText = `${included.toLocaleString(INTERFACE_LOCALE)} ${included === 1 ? "attachment" : "attachments"}`;
  if (missing > 0) {
    const missingText = `${missing.toLocaleString(INTERFACE_LOCALE)} unavailable ${missing === 1 ? "attachment was" : "attachments were"} missing and listed in the manifest`;
    return `Recovery bundle exported with ${includedText} (${missingText}). Credentials, provider sessions, and vault data were excluded.`;
  }
  return `Recovery bundle exported with ${includedText}. Credentials, provider sessions, and vault data were excluded.`;
}

function formatRecoveryImportResult(result: DatabaseRecoveryImportResult): string {
  if (result.status !== "imported") return "Recovery import cancelled.";
  if (result.summary.alreadyImported) {
    return "That recovery file was already imported into the authorized folder; no data was duplicated.";
  }
  const { projects, conversations, messages, attachments, missingAttachments } = result.summary;
  if (attachments !== undefined || missingAttachments !== undefined) {
    const count = attachments ?? 0;
    const missing = missingAttachments ?? 0;
    const attachmentText = `${count} ${count === 1 ? "attachment" : "attachments"}`;
    const missingSuffix = missing > 0
      ? ` (${missing} unavailable ${missing === 1 ? "attachment was" : "attachments were"} missing from the bundle.)`
      : "";
    return `Imported ${projects} projects, ${conversations} conversations, ${messages} messages, and ${attachmentText} under new identities with supervised access.${missingSuffix}`;
  }
  return `Imported ${projects} projects, ${conversations} conversations, and ${messages} messages under new identities with supervised access.`;
}

export interface DataSettingsProps {
  settings: AppSettings;
  disabled: boolean;
  providers: ProviderInfo[];
  archivedCount: number;
  onLoadArchived?: ArchivedConversationsLoader;
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
  archivedCount,
  onLoadArchived,
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
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [attachmentEstimate, setAttachmentEstimate] = useState<AttachmentStorageStatus | null>(null);
  const [attachmentEstimateUnavailable, setAttachmentEstimateUnavailable] = useState(!onReportCommand);
  const cache = useSettingAction();
  const compact = useSettingAction();
  const recovery = useSettingAction();
  const requestRef = useRef(onReportCommand);
  requestRef.current = onReportCommand;
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const includeAttachmentsRef = useRef<HTMLInputElement>(null);
  const includeAttachmentsId = useId();
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

  useLayoutEffect(() => {
    if (exportDialogOpen) includeAttachmentsRef.current?.focus();
  }, [exportDialogOpen]);

  useEffect(() => {
    if (!exportDialogOpen) return;
    if (!hasRequestChannel) {
      setAttachmentEstimate(null);
      setAttachmentEstimateUnavailable(true);
      return;
    }
    let active = true;
    setAttachmentEstimate(null);
    setAttachmentEstimateUnavailable(false);
    const request = requestRef.current;
    if (!request) return;
    void request({ type: "attachment.storage.get" }).then((event) => {
      if (!active) return;
      if (event.type === "request.result" && event.result.kind === "attachment.storage") {
        setAttachmentEstimate(event.result.storage);
        setAttachmentEstimateUnavailable(false);
      } else {
        setAttachmentEstimateUnavailable(true);
      }
    }).catch(() => {
      if (active) setAttachmentEstimateUnavailable(true);
    });
    return () => { active = false; };
  }, [exportDialogOpen, hasRequestChannel]);

  const recoveryUnavailable = disabled || recovery.busy;

  const openExportDialog = (): void => {
    if (recoveryUnavailable) return;
    if (exportDialogOpen) {
      setExportDialogOpen(false);
      return;
    }
    setIncludeAttachments(false);
    setExportDialogOpen(true);
  };

  const closeExportDialog = (): void => {
    setExportDialogOpen(false);
    exportTriggerRef.current?.focus();
  };

  const confirmExportRecoveryData = (): void => {
    if (recoveryUnavailable) return;
    const withAttachments = includeAttachments;
    setExportDialogOpen(false);
    exportTriggerRef.current?.focus();
    void recovery.run(
      () => window.inertia.exportRecoveryData(
        withAttachments ? { includeAttachments: true } : { includeAttachments: false },
      ),
      {
        key: "export",
        exclusive: true,
        success: (result) => formatRecoveryExportResult(result, withAttachments),
        failure: withAttachments
          ? "The recovery bundle could not be exported."
          : "The recovery file could not be exported.",
      },
    );
  };

  const importRecoveryData = (): void => {
    if (recoveryUnavailable) return;
    setExportDialogOpen(false);
    void recovery.run(() => window.inertia.importRecoveryData(), {
      key: "import",
      exclusive: true,
      success: (result) => formatRecoveryImportResult(result),
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
          description="Project paths and messages as JSON, or optionally bundled with retained attachments. Imports create new supervised identities."
          notice={recovery.notice}
          actions={(
            <>
              <button
                ref={exportTriggerRef}
                type="button"
                className="secondary-button"
                aria-disabled={recoveryUnavailable || undefined}
                aria-expanded={exportDialogOpen}
                onClick={openExportDialog}
              >
                <Download size={14} aria-hidden="true" />{recovery.pending === "export" ? "Exporting…" : "Export recovery file"}
              </button>
              <button type="button" className="secondary-button" aria-disabled={recoveryUnavailable || undefined} onClick={importRecoveryData}><Import size={14} aria-hidden="true" />{recovery.pending === "import" ? "Importing…" : "Import recovery file"}</button>
            </>
          )}
        />
        {exportDialogOpen && (
          <div
            className="recovery-export-dialog"
            role="group"
            aria-label="Export recovery options"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              if (recovery.busy) return;
              closeExportDialog();
            }}
          >
            <strong>Export recovery data</strong>
            <label className="recovery-export-option" htmlFor={includeAttachmentsId}>
              <input
                ref={includeAttachmentsRef}
                id={includeAttachmentsId}
                type="checkbox"
                checked={includeAttachments}
                disabled={recoveryUnavailable}
                onChange={(event) => setIncludeAttachments(event.currentTarget.checked)}
              />
              <span>Include attachments</span>
            </label>
            <small role="status" className="data-facts">
              {formatRetainedAttachmentEstimate(
                attachmentEstimate,
                attachmentEstimateUnavailable,
                hasRequestChannel,
              )}
            </small>
            <small>
              {includeAttachments
                ? "Exports a portable .tar bundle with messages and retained attachments. Credentials, provider sessions, and vault data are excluded."
                : "Exports a readable .json file with project paths and messages only. Attachments, credentials, provider sessions, and vault data are excluded."}
            </small>
            <div>
              <button type="button" className="secondary-button" aria-disabled={recoveryUnavailable || undefined} onClick={closeExportDialog}>Cancel</button>
              <button type="button" className="secondary-button" aria-disabled={recoveryUnavailable || undefined} onClick={confirmExportRecoveryData}>
                {includeAttachments ? "Export recovery bundle…" : "Export recovery file…"}
              </button>
            </div>
          </div>
        )}
      </SettingsGroup>
      <ArchivedChats count={archivedCount} load={onLoadArchived} providers={providers} disabled={disabled} onUnarchive={onUnarchive} />
      <SettingsGroup title="Defaults" headingId="restore-defaults-heading">
        <RestoreDefaults confirmDestructiveActions={settings.confirmDestructiveActions} disabled={disabled} onRestoreDefaults={onRestoreDefaults} />
      </SettingsGroup>
    </>
  );
}
