import { Activity, Trash2 } from "lucide-react";
import type { DatabaseBackupStatus } from "@shared/contracts";
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

export function formatHealthBytes(bytes: number | null): string {
  return bytes === null ? "Unavailable" : formatBytes(bytes);
}

interface StorageStatusSettingsProps {
  health: AppHealthSnapshot | null;
  healthUnavailable: boolean;
  clearingCache: boolean;
  clearCacheNotice: SettingNotice | null;
  backup?: DatabaseBackupStatus;
  onClearCache(): Promise<void>;
}

export function StorageStatusSettings({
  health,
  healthUnavailable,
  clearingCache,
  clearCacheNotice,
  backup,
  onClearCache,
}: StorageStatusSettingsProps): React.JSX.Element {
  return <>
    <SettingActionRow
      id="resource-health"
      className="runtime-log-setting app-health-setting"
      title={<><Activity size={14} />Local resource health</>}
      description="Sampled only while open; covers Inertia processes and app storage, never project files."
      details={health ? <>
        <span className="app-health-grid">
          <span><b>{formatHealthBytes(health.totalMemoryBytes)}</b><small>App memory</small></span>
          <span><b>{formatHealthBytes(health.databaseBytes)}</b><small>Database</small></span>
          <span><b>{formatHealthBytes(health.cacheBytes)}</b><small>Browser cache</small></span>
          <span><b>{formatHealthBytes(health.temporaryAttachmentBytes)}</b><small>Temporary attachments</small></span>
        </span>
        <small>Measured <time dateTime={health.sampledAt}>{new Date(health.sampledAt).toLocaleTimeString(INTERFACE_LOCALE)}</time>. Database includes its active journal; backup files and saved attachment files are not included in these storage totals.</small>
        <small>Memory breakdown: main {health.mainProcess ? `${formatBytes(health.mainProcess.memoryBytes)} (${health.mainProcess.cpuPercent.toFixed(1)}% CPU)` : "unavailable"} · UI {health.rendererProcesses ? `${formatBytes(health.rendererProcesses.reduce((total, process) => total + process.memoryBytes, 0))} across ${health.rendererProcesses.length} ${health.rendererProcesses.length === 1 ? "process" : "processes"}` : "unavailable"} · local service {health.runtimeProcess ? formatBytes(health.runtimeProcess.memoryBytes) : "unavailable"} ({health.runtimePhase ?? "state unavailable"}).</small>
        {health.warnings.length > 0 && <small className="settings-card-note" role="status">
          <strong>Partial health data</strong>
          {`: ${health.warnings.map(({ message }) => message).join(" ")}`}
        </small>}
      </> : <small>{healthUnavailable ? "Local health data is unavailable." : "Measuring local usage…"}</small>}
      notice={clearCacheNotice}
      actions={<button type="button" className="secondary-button" disabled={clearingCache || !health}
        onClick={() => { void onClearCache(); }}><Trash2 size={14} />{clearingCache ? "Clearing…" : "Clear browser cache"}</button>}
    />
    <SettingActionRow
      id="database-backup"
      className="runtime-log-setting"
      title="Full local database backup"
      description="Validated SQLite copies include presets, session references, execution context, Git artifacts, and attachment records—not secrets or attachment bytes."
      details={<>
        <small>{backup?.lastValidatedAt
          ? <>Last validated backup: <time dateTime={backup.lastValidatedAt} title={backup.lastValidatedAt}>{new Date(backup.lastValidatedAt).toLocaleString(INTERFACE_LOCALE)}</time>.</>
          : "No validated backup yet. Inertia creates one after a short startup quiet period or the first completed turn."}</small>
        <small>Automatic backups rotate every {DATABASE_BACKUP_INTERVAL_MS / 3_600_000} hour, targeting {DATABASE_BACKUP_MAX_COUNT} copies and {formatBytes(DATABASE_BACKUP_MAX_TOTAL_BYTES)} in total. The newest validated copy is kept even above that target.</small>
        <small>Archiving keeps chat data. Chats stay stored until you delete them; clearing browser cache keeps chats and backups.</small>
      </>}
    />
  </>;
}
