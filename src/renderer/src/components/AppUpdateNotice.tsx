import { Download, X } from "lucide-react";

import type { AppUpdateStatus } from "@shared/desktop";
import { IconButton } from "./ui";

export function AppUpdateNotice({
  status,
  onDismiss,
  onOpenRelease,
}: {
  status: AppUpdateStatus;
  onDismiss: () => void;
  onOpenRelease: () => void;
}): React.JSX.Element {
  return (
    <aside className="app-update-notice" aria-label="Inertia update available">
      <Download size={15} aria-hidden="true" />
      <span>
        <strong>Inertia {status.latestVersion} is ready</strong>
        <small>Review the release before downloading when you’re ready.</small>
      </span>
      <button type="button" onClick={onOpenRelease}>View release</button>
      <IconButton label="Dismiss update" onClick={onDismiss}>
        <X size={14} />
      </IconButton>
    </aside>
  );
}
