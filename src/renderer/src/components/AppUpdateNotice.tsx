import { Download, RefreshCw, RotateCcw, X } from "lucide-react";

import type { AppUpdateStatus } from "@shared/desktop";
import { IconButton } from "./ui";

function title(status: AppUpdateStatus): string {
  if (status.state === "downloading") return `Downloading Inertia ${status.latestVersion}`;
  if (status.state === "downloaded") return `Inertia ${status.latestVersion} is ready`;
  if (status.state === "installing") return "Preparing a safe restart";
  if (status.state === "cancelled") return "Update download cancelled";
  if (status.state === "failed") return "Update needs attention";
  return `Inertia ${status.latestVersion} is available`;
}

export function AppUpdateNotice({
  status,
  onDismiss,
  onOpenRelease,
  onDownload,
  onCancelDownload,
  onInstall,
}: {
  status: AppUpdateStatus;
  onDismiss: () => void;
  onOpenRelease: () => void;
  onDownload: () => void;
  onCancelDownload: () => void;
  onInstall: () => void;
}): React.JSX.Element {
  const progress = status.progress;
  const downloadable = status.delivery === "in-app"
    && ["available", "cancelled", "failed"].includes(status.state);
  return (
    <aside className="app-update-notice" aria-label="Inertia application update">
      {status.state === "downloading" || status.state === "installing"
        ? <RefreshCw className="app-update-spin" size={15} aria-hidden="true" />
        : <Download size={15} aria-hidden="true" />}
      <span className="app-update-copy">
        <strong>{title(status)}</strong>
        <small aria-live="polite">{status.message}</small>
        {status.state === "downloading" && progress && (
          <span
            className="app-update-progress"
            role="progressbar"
            aria-label="Update download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress.percent)}
          >
            <span style={{ width: `${progress.percent}%` }} />
          </span>
        )}
      </span>
      <span className="app-update-actions">
        {downloadable && (
          <button type="button" onClick={onDownload}>
            {status.state === "available" ? "Download" : "Retry"}
          </button>
        )}
        {status.state === "downloading" && (
          <button type="button" onClick={onCancelDownload}>Cancel</button>
        )}
        {status.state === "downloaded" && (
          <button type="button" onClick={onInstall}>Restart to update</button>
        )}
        {status.delivery === "manual" && status.state === "available" && (
          <button type="button" onClick={onOpenRelease}>View release</button>
        )}
        {status.delivery === "in-app" && status.releaseUrl && status.state !== "installing" && (
          <button type="button" className="app-update-secondary" onClick={onOpenRelease}>
            Release notes
          </button>
        )}
      </span>
      {status.state === "available" ? (
        <IconButton label="Dismiss update" onClick={onDismiss}>
          <X size={14} />
        </IconButton>
      ) : status.state === "cancelled" || status.state === "failed" ? (
        <RotateCcw size={14} aria-hidden="true" />
      ) : <span aria-hidden="true" />}
    </aside>
  );
}
