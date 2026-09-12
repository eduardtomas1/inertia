import { useCallback, useEffect, useRef, useState } from "react";

import type { AppUpdateStatus } from "@shared/desktop";

const INITIAL_CHECK_DELAY_MS = 2_500;

export interface AppUpdateController {
  status: AppUpdateStatus | null;
  checking: boolean;
  error: string | null;
  check: (force?: boolean) => Promise<void>;
  download: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  install: () => Promise<void>;
  dismissError: () => void;
  openRelease: () => Promise<void>;
}

export function useAppUpdate(): AppUpdateController {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestRevision = useRef(-1);

  const acceptStatus = useCallback((next: AppUpdateStatus): boolean => {
    if (next.revision < latestRevision.current) return false;
    latestRevision.current = next.revision;
    setStatus(next);
    return true;
  }, []);
  const acceptResult = useCallback((next: AppUpdateStatus): void => {
    if (!acceptStatus(next)) return;
    if (next.state === "failed" || next.state === "unavailable" || next.installBlocker) setError(next.message);
  }, [acceptStatus]);

  const check = useCallback(async (force = false): Promise<void> => {
    setChecking(true);
    setError(null);
    try {
      const result = await window.inertia.checkAppUpdate(force);
      // Background checks remain quiet; an explicitly requested check reports failure.
      if (force) acceptResult(result); else acceptStatus(result);
    } catch (cause) {
      setError("The update check could not be completed.");
      throw cause;
    } finally {
      setChecking(false);
    }
  }, [acceptResult, acceptStatus]);

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

  const openRelease = useCallback(async (): Promise<void> => {
    if (!status?.releaseUrl) return;
    setError(null);
    try {
      await window.inertia.openExternal(status.releaseUrl);
    } catch (cause) {
      setError("The release page could not be opened. Try again or check your default browser.");
      throw cause;
    }
  }, [status]);
  const download = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      acceptResult(await window.inertia.downloadAppUpdate());
    } catch (cause) {
      setError("The update download could not be started.");
      throw cause;
    }
  }, [acceptResult]);
  const cancelDownload = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      acceptResult(await window.inertia.cancelAppUpdateDownload());
    } catch (cause) {
      setError("The update download could not be cancelled.");
      throw cause;
    }
  }, [acceptResult]);
  const install = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      acceptResult(await window.inertia.installAppUpdate());
    } catch (cause) {
      setError("The update restart could not be started safely.");
      throw cause;
    }
  }, [acceptResult]);
  const dismissError = useCallback(() => setError(null), []);

  return {
    status,
    checking,
    error,
    check,
    download,
    cancelDownload,
    install,
    dismissError,
    openRelease,
  };
}
