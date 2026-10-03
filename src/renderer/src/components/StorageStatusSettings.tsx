import { HardDrive, Trash2 } from "lucide-react";
import type { DatabaseBackupStatus } from "@shared/contracts";
import type { AppHealthSnapshot } from "@shared/desktop";
import {
  DATABASE_BACKUP_INTERVAL_MS,
  DATABASE_BACKUP_MAX_COUNT,
  DATABASE_BACKUP_MAX_TOTAL_BYTES,
} from "@shared/storage-policy";
import { INTERFACE_LOCALE } from "../lib/locale";

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  const unit = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1_024)),
  );
  const value = bytes / 1_024 ** unit;
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatHealthBytes(bytes: number | null): string {
  return bytes === null ? "Unavailable" : formatStorageBytes(bytes);
}

interface StorageStatusSettingsProps {
  health: AppHealthSnapshot | null;
  healthStatus: string | null;
  clearingCache: boolean;
  backup?: DatabaseBackupStatus;
  onClearCache(): Promise<void>;
}

export function StorageStatusSettings({
  health,
  healthStatus,
  clearingCache,
  backup,
  onClearCache,
}: StorageStatusSettingsProps): React.JSX.Element {
  return <>
    <div className="codex-binary-path runtime-log-setting app-health-setting">
      <span>
        <strong><HardDrive size={14} aria-hidden="true" />Local storage</strong>
        <small>Sampled only while open; covers app storage, never project files.</small>
        {health ? <>
          <span className="app-health-grid">
            <span><b>{formatHealthBytes(health.databaseBytes)}</b><small>Database</small></span>
            <span><b>{formatHealthBytes(health.cacheBytes)}</b><small>Browser cache</small></span>
            <span><b>{formatHealthBytes(health.temporaryAttachmentBytes)}</b><small>Temporary attachments</small></span>
          </span>
          <small>Measured <time dateTime={health.sampledAt}>{new Date(health.sampledAt).toLocaleTimeString(INTERFACE_LOCALE)}</time>. Database includes its active journal; backup files and saved attachment files are not included in these storage totals.</small>
          {health.warnings.length > 0 && <small className="settings-card-note" role="status">
            <strong>Partial health data</strong>
            {`: ${health.warnings.map(({ message }) => message).join(" ")}`}
          </small>}
        </> : <small>Measuring local usage…</small>}
      </span>
      <div><button type="button" className="secondary-button" disabled={clearingCache || !health}
        onClick={() => { void onClearCache(); }}><Trash2 size={14} />{clearingCache ? "Clearing…" : "Clear browser cache"}</button></div>
    </div>
    {healthStatus && <p className="settings-card-note" role="status">{healthStatus}</p>}
    <div className="codex-binary-path runtime-log-setting">
      <span>
        <strong>Full local database backup</strong>
        <small>Validated SQLite copies include presets, session references, execution context, Git artifacts, and attachment records—not secrets or attachment bytes.</small>
        <small>{backup?.lastValidatedAt
          ? <>Last validated backup: <time dateTime={backup.lastValidatedAt} title={backup.lastValidatedAt}>{new Date(backup.lastValidatedAt).toLocaleString(INTERFACE_LOCALE)}</time>.</>
          : "No validated backup yet. Inertia creates one after a short startup quiet period or the first completed turn."}</small>
        <small>Automatic backups rotate every {DATABASE_BACKUP_INTERVAL_MS / 3_600_000} hour, targeting {DATABASE_BACKUP_MAX_COUNT} copies and {formatStorageBytes(DATABASE_BACKUP_MAX_TOTAL_BYTES)} in total. The newest validated copy is kept even above that target.</small>
        <small>Archiving keeps chat data. Chats stay stored until you delete them; clearing browser cache keeps chats and backups.</small>
      </span>
    </div>
  </>;
}
