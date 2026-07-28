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
  check: (force?: boolean) => Promise<void>;
  dismiss: () => void;
  openRelease: () => Promise<void>;
}

export function useAppUpdate(): AppUpdateController {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    readDismissedVersion,
  );

  const check = useCallback(async (force = false): Promise<void> => {
    setChecking(true);
    try {
      setStatus(await window.inertia.checkAppUpdate(force));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void check(false).catch(() => undefined);
    }, INITIAL_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [check]);

  const visible = useMemo(
    () => status?.state === "available"
      && status.latestVersion !== dismissedVersion,
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

  return {
    status,
    checking,
    visible,
    check,
    dismiss,
    openRelease,
  };
}
