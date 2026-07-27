import {
  CheckCircle2,
  CircleAlert,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceStatus,
} from "@shared/contracts";
import { IconButton } from "./ui";

const DISMISSED_UPDATES_KEY = "inertia:provider-updates-dismissed:v1";
const DISMISSED_OPERATIONS_KEY =
  "inertia:provider-maintenance-operations-dismissed:v1";
const MAX_DISMISSED_OPERATIONS = 64;

type DismissedUpdates = Partial<Record<string, string>>;

function readDismissedUpdates(): DismissedUpdates {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(
      window.localStorage.getItem(DISMISSED_UPDATES_KEY) ?? "{}",
    ) as unknown;
    return value && typeof value === "object"
      ? value as DismissedUpdates
      : {};
  } catch {
    return {};
  }
}

function readDismissedOperations(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(DISMISSED_OPERATIONS_KEY) ?? "[]",
    ) as unknown;
    return new Set(
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
          .slice(-MAX_DISMISSED_OPERATIONS)
        : [],
    );
  } catch {
    return new Set();
  }
}

function saveDismissedOperations(operationIds: ReadonlySet<string>): void {
  try {
    window.sessionStorage.setItem(
      DISMISSED_OPERATIONS_KEY,
      JSON.stringify([...operationIds].slice(-MAX_DISMISSED_OPERATIONS)),
    );
  } catch {
    // A dismissal may remain component-local when session storage is unavailable.
  }
}

export function shouldShowProviderMaintenanceNotice({
  operation,
  updateAvailable,
  updateDismissed,
  operationDismissed,
  managedActionAvailable = false,
}: {
  operation: ProviderMaintenanceOperation | null;
  updateAvailable: boolean;
  updateDismissed: boolean;
  operationDismissed: boolean;
  managedActionAvailable?: boolean;
}): boolean {
  const activeOperation = operation?.status === "queued"
    || operation?.status === "running";
  if (activeOperation) return true;
  if (operation) return !operationDismissed;
  return (updateAvailable || managedActionAvailable) && !updateDismissed;
}

function operationLabel(operation: ProviderMaintenanceOperation): string {
  switch (operation.status) {
    case "queued": return "Update queued";
    case "running": return "Updating";
    case "succeeded": return operation.afterVersion
      ? `Updated to ${operation.afterVersion}`
      : "Update completed";
    case "unchanged": return "Already current";
    case "failed": return "Update failed";
    case "cancelled": return "Update cancelled";
  }
}

export interface ProviderMaintenanceNoticeProps {
  providerLabel: string;
  status: ProviderMaintenanceStatus | null;
  operation: ProviderMaintenanceOperation | null;
  disabled?: boolean;
  dismissible?: boolean;
  showManagedUpdateAction?: boolean;
  onRefresh: () => Promise<void>;
  onUpdate: () => Promise<void>;
  onCancel: (operationId: string) => Promise<void>;
  onOpenInstructions: (url: string) => void;
}

export function ProviderMaintenanceNotice({
  providerLabel,
  status,
  operation,
  disabled = false,
  dismissible = true,
  showManagedUpdateAction = false,
  onRefresh,
  onUpdate,
  onCancel,
  onOpenInstructions,
}: ProviderMaintenanceNoticeProps): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(readDismissedUpdates);
  const [dismissedOperations, setDismissedOperations] = useState(
    readDismissedOperations,
  );
  const [requestError, setRequestError] = useState<string | null>(null);
  const activeOperation = operation?.status === "queued"
    || operation?.status === "running";
  const updateVersion = status?.latestVersion ?? "available";
  const updateAvailable = status?.versionStatus === "update-available";
  const managedActionAvailable = Boolean(
    showManagedUpdateAction
    && status?.installedVersion
    && status.installMethod === "provider-managed"
    && status.updateAvailability === "available"
    && status.versionStatus === "unknown",
  );
  const isDismissed = dismissed[status?.providerId ?? ""] === updateVersion;
  const operationDismissed = Boolean(
    dismissible
    && operation
    && !activeOperation
    && dismissedOperations.has(operation.id),
  );
  const visible = shouldShowProviderMaintenanceNotice({
    operation,
    updateAvailable,
    updateDismissed: isDismissed,
    operationDismissed,
    managedActionAvailable,
  });

  useEffect(() => {
    setRequestError(null);
  }, [operation?.id, status?.checkedAt]);

  if (!status || !visible) return null;

  const dismiss = (): void => {
    if (operation && !activeOperation) {
      const next = new Set(dismissedOperations).add(operation.id);
      setDismissedOperations(next);
      saveDismissedOperations(next);
      return;
    }
    const next = {
      ...dismissed,
      [status.providerId]: updateVersion,
    };
    setDismissed(next);
    try {
      window.localStorage.setItem(DISMISSED_UPDATES_KEY, JSON.stringify(next));
    } catch {
      // A dismissal may remain session-only when storage is unavailable.
    }
  };
  const run = async (action: () => Promise<void>): Promise<void> => {
    setRequestError(null);
    try {
      await action();
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "The update action failed.",
      );
    }
  };
  const Icon = activeOperation
    ? LoaderCircle
    : operation?.status === "failed"
      ? CircleAlert
      : operation
        ? CheckCircle2
        : Download;
  const title = operation
    ? operationLabel(operation)
    : updateAvailable
      ? `${providerLabel} update available`
      : `${providerLabel} maintenance`;
  const detail = requestError
    ?? operation?.message
    ?? (managedActionAvailable ? status.message : null)
    ?? [
      status.installedVersion ? `Installed ${status.installedVersion}` : null,
      status.latestVersion ? `Latest ${status.latestVersion}` : null,
    ].filter(Boolean).join(" · ");

  return (
    <div
      className={`provider-maintenance-notice${activeOperation ? " is-active" : ""}${operation?.status === "failed" ? " is-failed" : ""}`}
      role={operation?.status === "failed" ? "alert" : "status"}
      aria-live="polite"
      aria-busy={activeOperation}
    >
      <Icon
        size={13}
        className={activeOperation ? "is-spinning" : undefined}
        aria-hidden="true"
      />
      <span>
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      <span className="provider-maintenance-actions">
        {activeOperation ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void run(() => onCancel(operation.id))}
          >
            Cancel
          </button>
        ) : (
          updateAvailable || managedActionAvailable
        ) && status.updateAvailability === "available" ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (!window.confirm(
                managedActionAvailable
                  ? `Ask ${providerLabel} to check for and install updates using its provider-managed updater?`
                  : `Update ${providerLabel} from ${status.installedVersion ?? "the installed version"} to ${status.latestVersion ?? "the latest version"}?`,
              )) return;
              void run(onUpdate);
            }}
          >
            <Download size={11} aria-hidden="true" />
            {managedActionAvailable ? "Check & update" : "Update"}
          </button>
        ) : updateAvailable
          && status.updateAvailability === "instructions-only" ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onOpenInstructions(status.instructionsUrl)}
            >
              <ExternalLink size={11} aria-hidden="true" />
              Instructions
            </button>
          ) : !operation ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void run(onRefresh)}
            >
              <RefreshCw size={11} aria-hidden="true" />
              Check
            </button>
          ) : null}
        {dismissible && !activeOperation && (
          <IconButton label={`Dismiss ${providerLabel} update notice`} onClick={dismiss}>
            <X size={12} />
          </IconButton>
        )}
      </span>
    </div>
  );
}
