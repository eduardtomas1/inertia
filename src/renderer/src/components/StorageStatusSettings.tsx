import { useId } from "react";
import { Database, Trash2 } from "lucide-react";
import type { DatabaseBackupStatus } from "@shared/contracts";
import type { DatabaseCompactionState, DatabaseStorageStatus } from "@shared/database-storage";
import type { AppHealthSnapshot } from "@shared/desktop";
import {
  DATABASE_BACKUP_INTERVAL_MS,
  DATABASE_BACKUP_MAX_COUNT,
  DATABASE_BACKUP_MAX_TOTAL_BYTES,
} from "@shared/storage-policy";
import { INTERFACE_LOCALE } from "../lib/locale";
import { formatBytes } from "../utils/formatBytes";
import { SettingActionRow } from "./settings/SettingsLayout";
import type { SettingNotice } from "./settings/useSettingAction";

export const ACTIVE_TURN_COMPACT_EXPLANATION = "Wait for active turns to finish before compacting the database.";

export function formatHealthBytes(bytes: number | null): string {
  return bytes === null ? "unavailable" : formatBytes(bytes);
}

export function compactionStateLabel(state: DatabaseCompactionState | undefined): string {
  switch (state) {
    case "backing-up":
      return "Backing up…";
    case "checkpointing":
      return "Checkpointing WAL…";
    case "vacuuming":
      return "Compacting…";
    case "reclaiming":
      return "Reclaiming space…";
    default:
      return "Compacting…";
  }
}

interface StorageStatusSettingsProps {
  health: AppHealthSnapshot | null;
  healthUnavailable: boolean;
  clearingCache: boolean;
  clearCacheNotice: SettingNotice | null;
  backup?: DatabaseBackupStatus;
  databaseStorage?: DatabaseStorageStatus | null;
  databaseStorageUnavailable?: boolean;
  compactingDatabase?: boolean;
  compactDatabaseNotice?: SettingNotice | null;
  hasActiveTurns?: boolean;
  disabled?: boolean;
  onClearCache(): Promise<void>;
  onCompactDatabase?: () => Promise<void>;
}

export function StorageStatusSettings({
  health,
  healthUnavailable,
  clearingCache,
  clearCacheNotice,
  backup,
  databaseStorage = null,
  databaseStorageUnavailable = false,
  compactingDatabase = false,
  compactDatabaseNotice = null,
  hasActiveTurns = false,
  disabled = false,
  onClearCache,
  onCompactDatabase,
}: StorageStatusSettingsProps): React.JSX.Element {
  const blockedNoteId = useId();
  const clearUnavailable = clearingCache || !health;
  const compactionBusy = compactingDatabase || databaseStorage?.busy === true;
  const blockedExplanation = hasActiveTurns
    ? ACTIVE_TURN_COMPACT_EXPLANATION
    : databaseStorage?.blockedReason ?? null;
  const compactUnavailable = disabled
    || compactionBusy
    || !onCompactDatabase
    || !databaseStorage
    || blockedExplanation !== null;
  const backupCopyLabel = databaseStorage
    ? `${databaseStorage.backupCount} ${databaseStorage.backupCount === 1 ? "copy" : "copies"}`
    : "";
  return <>
    <SettingActionRow
      id="resource-health"
      className="runtime-log-setting"
      title="Local storage"
      details={health ? <>
        <small className="data-facts">
          {`Database ${formatHealthBytes(health.databaseBytes)} · Browser cache ${formatHealthBytes(health.cacheBytes)} · Temporary attachments ${formatHealthBytes(health.temporaryAttachmentBytes)}`}
          {" · Measured "}
          <time dateTime={health.sampledAt}>{new Date(health.sampledAt).toLocaleTimeString(INTERFACE_LOCALE)}</time>
        </small>
        {health.warnings.length > 0 && <small role="status">
          {`Partial health data: ${health.warnings.map(({ message }) => message).join(" ")}`}
        </small>}
      </> : <small role="status">{healthUnavailable ? "Local health data is unavailable." : "Measuring local usage…"}</small>}
      notice={clearCacheNotice}
      actions={<button
        type="button"
        className="secondary-button"
        aria-disabled={clearUnavailable || undefined}
        onClick={() => { if (!clearUnavailable) void onClearCache(); }}
      ><Trash2 size={14} aria-hidden="true" />{clearingCache ? "Clearing…" : "Clear browser cache"}</button>}
    />
    <SettingActionRow
      id="database-storage"
      className="runtime-log-setting"
      title="Database storage"
      details={<>
        {databaseStorage ? (
          <small className="data-facts">
            {`Database ${formatBytes(databaseStorage.databaseBytes)} · Reclaimable ${formatBytes(databaseStorage.reclaimableBytes)} · WAL ${formatBytes(databaseStorage.walBytes)} · Backups ${formatBytes(databaseStorage.backupBytes)} (${backupCopyLabel})`}
          </small>
        ) : (
          <small role="status">
            {databaseStorageUnavailable ? "Database storage details are unavailable." : "Measuring database storage…"}
          </small>
        )}
        {compactionBusy && (
          <small role="status" aria-live="polite">
            {compactionStateLabel(databaseStorage?.compactionState)}
          </small>
        )}
        {!compactionBusy && blockedExplanation && (
          <small id={blockedNoteId} role="status">{blockedExplanation}</small>
        )}
      </>}
      notice={compactDatabaseNotice}
      actions={<button
        type="button"
        className="secondary-button"
        aria-disabled={compactUnavailable || undefined}
        aria-describedby={!compactionBusy && blockedExplanation ? blockedNoteId : undefined}
        onClick={() => { if (!compactUnavailable && onCompactDatabase) void onCompactDatabase(); }}
      ><Database size={14} aria-hidden="true" />{compactionBusy ? compactionStateLabel(databaseStorage?.compactionState) : "Compact now"}</button>}
    />
    <SettingActionRow
      id="database-backup"
      className="runtime-log-setting"
      title="Full local database backup"
      description="Chats, settings and attachment records, without secrets or attachment files."
      details={<small className="data-facts">
        {backup?.lastValidatedAt
          ? <>Last validated <time dateTime={backup.lastValidatedAt}>{new Date(backup.lastValidatedAt).toLocaleString(INTERFACE_LOCALE)}</time></>
          : "No validated backup yet"}
        {` · Every ${DATABASE_BACKUP_INTERVAL_MS / 3_600_000} hour · ${DATABASE_BACKUP_MAX_COUNT} copies, ${formatBytes(DATABASE_BACKUP_MAX_TOTAL_BYTES)} in total`}
      </small>}
    />
  </>;
}
