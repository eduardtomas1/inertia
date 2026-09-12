import type { AppUpdateStatus } from "../../src/shared/desktop";

/** Synthetic release metadata shared by deterministic controller/geometry tests. */
export function updateStatus(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return { revision: 1, channel: "stable", state: "available", freshness: "fresh", delivery: "in-app",
    deliveryReason: null, installBlocker: null, progress: null, currentVersion: "1.2.2", latestVersion: "1.2.3",
    releaseUrl: "https://github.com/eduardtomas1/inertia/releases/tag/v1.2.3",
    releaseNotes: "A calmer update experience.\n\n- Follow downloads from the sidebar.\n- Read release notes without leaving your work.\n- Review active work before restarting.",
    checkedAt: "2030-01-01T12:00:00.000Z", lastAttemptedAt: "2030-01-01T12:00:00.000Z",
    message: "Inertia 1.2.3 is available.", ...overrides };
}
