import { Trash2 } from "lucide-react";
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
  return bytes === null ? "unavailable" : formatBytes(bytes);
}

interface StorageStatusSettingsProps {
  health: AppHealthSnapshot | null;
  healthUnavailable: boolean;
  clearingCache: boolean;
  clearCacheNotice: SettingNotice | null;
  backup?: DatabaseBackupStatus;
  onClearCache(): Promise<void>;
}

function processMemory(health: AppHealthSnapshot): string {
  const renderer = health.rendererProcesses
    ? formatBytes(health.rendererProcesses.reduce((total, process) => total + process.memoryBytes, 0))
    : "unavailable";
  return [
    `Main ${health.mainProcess ? formatBytes(health.mainProcess.memoryBytes) : "unavailable"}`,
    `Interface ${renderer}`,
    `Local service ${health.runtimeProcess ? formatBytes(health.runtimeProcess.memoryBytes) : "unavailable"}`,
  ].join(" · ");
}

export function StorageStatusSettings({
  health,
  healthUnavailable,
  clearingCache,
  clearCacheNotice,
  backup,
  onClearCache,
}: StorageStatusSettingsProps): React.JSX.Element {
  const clearUnavailable = clearingCache || !health;
  return <>
    <SettingActionRow
      id="resource-health"
      className="runtime-log-setting"
      title="Local resource health"
      details={health ? <>
        <small className="data-facts">
          {`Memory ${formatHealthBytes(health.totalMemoryBytes)} · Database ${formatHealthBytes(health.databaseBytes)} · Browser cache ${formatHealthBytes(health.cacheBytes)} · Temporary attachments ${formatHealthBytes(health.temporaryAttachmentBytes)}`}
        </small>
        <small className="data-facts">
          {processMemory(health)}
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
      id="database-backup"
      className="runtime-log-setting"
      title="Full local database backup"
      description="Chats, settings and attachment records, without secrets or attachment files."
      details={<small className="data-facts">
        {backup?.lastValidatedAt
          ? <>Last validated <time dateTime={backup.lastValidatedAt} title={backup.lastValidatedAt}>{new Date(backup.lastValidatedAt).toLocaleString(INTERFACE_LOCALE)}</time></>
          : "No validated backup yet"}
        {` · Every ${DATABASE_BACKUP_INTERVAL_MS / 3_600_000} hour · ${DATABASE_BACKUP_MAX_COUNT} copies, ${formatBytes(DATABASE_BACKUP_MAX_TOTAL_BYTES)} in total`}
      </small>}
    />
  </>;
}
