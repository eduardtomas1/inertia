import { useCallback, useEffect, useMemo, useState } from "react";

import type { AppUpdateStatus } from "@shared/desktop";

const DISMISSED_APP_UPDATE_KEY = "inertia:app-update-dismissed:v1";
const INITIAL_CHECK_DELAY_MS = 2_500;
const RELEASE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function readDismissedVersion(): string | null {
  try {
    const value = window.localStorage.getItem(DISMISSED_APP_UPDATE_KEY);
    return value && RELEASE_VERSION_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function storeDismissedVersion(version: string): void {
  try {
    window.localStorage.setItem(DISMISSED_APP_UPDATE_KEY, version);
  } catch {
    // The notice may return after restart if storage is unavailable, but the
    // renderer must remain usable in privacy-restricted environments.
  }
}

export interface AppUpdateController {
  status: AppUpdateStatus | null;
  checking: boolean;
  visible: boolean;
  error: string | null;
  check: (force?: boolean) => Promise<void>;
  download: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
  dismissError: () => void;
  openRelease: () => Promise<void>;
}

export function useAppUpdate(): AppUpdateController {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    readDismissedVersion,
  );

  const acceptStatus = useCallback((next: AppUpdateStatus): void => {
    setStatus((current) => !current || next.revision >= current.revision ? next : current);
  }, []);

  const check = useCallback(async (force = false): Promise<void> => {
    setChecking(true);
    setError(null);
    try {
      acceptStatus(await window.inertia.checkAppUpdate(force));
    } catch (cause) {
      setError("The update check could not be completed.");
      throw cause;
    } finally {
      setChecking(false);
    }
  }, [acceptStatus]);

  useEffect(() => {
    const subscribe = window.inertia?.onAppUpdateStatus;
    const unsubscribe = typeof subscribe === "function"
      ? subscribe(acceptStatus)
      : () => undefined;
    const timer = window.setTimeout(() => {
      void check(false).catch(() => undefined);
    }, INITIAL_CHECK_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [acceptStatus, check]);

  const visible = useMemo(
    () => Boolean(status && (
      status.state === "available"
        ? status.latestVersion !== dismissedVersion
        : ["downloading", "cancelled", "downloaded", "installing", "failed"].includes(
            status.state,
          )
    )),
    [dismissedVersion, status],
  );
  const dismiss = useCallback(() => {
    if (status?.state !== "available" || !status.latestVersion) return;
    storeDismissedVersion(status.latestVersion);
    setDismissedVersion(status.latestVersion);
  }, [status]);
  const openRelease = useCallback(async (): Promise<void> => {
    if (!status?.releaseUrl) return;
    await window.inertia.openExternal(status.releaseUrl);
  }, [status]);
  const download = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      acceptStatus(await window.inertia.downloadAppUpdate());
    } catch (cause) {
      setError("The update download could not be started.");
      throw cause;
    }
  }, [acceptStatus]);
  const cancelDownload = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      acceptStatus(await window.inertia.cancelAppUpdateDownload());
    } catch (cause) {
      setError("The update download could not be cancelled.");
      throw cause;
    }
  }, [acceptStatus]);
  const install = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      acceptStatus(await window.inertia.installAppUpdate());
    } catch (cause) {
      setError("The update restart could not be started safely.");
      throw cause;
    }
  }, [acceptStatus]);
  const dismissError = useCallback(() => setError(null), []);

  return {
    status,
    checking,
    visible,
    error,
    check,
    download,
    cancelDownload,
    install,
    dismiss,
    dismissError,
    openRelease,
  };
}
