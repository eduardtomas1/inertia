import { ArchiveRestore, Clipboard, ShieldAlert, X } from "lucide-react";
import { useState } from "react";

import type { DatabaseRecoveryStartupNotice } from "@shared/desktop";
import { IconButton } from "./ui";

export function DatabaseRecoveryNotice({
  notice,
  onDismiss,
  onImportRecovery,
  onCopyReport,
}: {
  notice: DatabaseRecoveryStartupNotice;
  onDismiss: () => void;
  onImportRecovery: () => Promise<void>;
  onCopyReport: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState<"import" | "report" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    action: "import" | "report",
    operation: () => Promise<void>,
  ): Promise<void> => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      await operation();
    } catch (operationError) {
      setError(operationError instanceof Error
        ? operationError.message
        : "The recovery action could not be completed.");
    } finally {
      setBusy(null);
    }
  };
  const createdEmpty = notice.outcome === "created-empty";
  const detail = createdEmpty
    ? notice.trigger === "primary-missing"
      ? "The primary database was missing and no valid backup was available."
      : notice.preservedCorruptPrimary
        ? "No valid backup was available. The damaged primary was preserved for recovery."
        : "No valid backup was available, so Inertia created a new empty database."
    : notice.trigger === "primary-missing"
      ? "The primary database was missing, so Inertia restored the newest validated backup."
      : "The previous primary failed validation; recovery details are available in the diagnostic report.";
  return (
    <aside
      className={`database-recovery-notice${createdEmpty ? " is-critical" : ""}`}
      aria-label="Database recovery warning"
      role="alert"
    >
      <ShieldAlert size={17} aria-hidden="true" />
      <span>
        <strong>{createdEmpty
          ? "Inertia started with empty data"
          : "Inertia restored a validated backup"}</strong>
        <small>{error ?? detail}</small>
      </span>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => { void run("import", onImportRecovery); }}
      >
        <ArchiveRestore size={13} aria-hidden="true" />
        {busy === "import" ? "Importing…" : "Import recovery file"}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => { void run("report", onCopyReport); }}
      >
        <Clipboard size={13} aria-hidden="true" />
        {busy === "report" ? "Copying…" : "Copy report"}
      </button>
      <IconButton label="Dismiss database recovery warning" onClick={onDismiss}>
        <X size={14} />
      </IconButton>
    </aside>
  );
}
