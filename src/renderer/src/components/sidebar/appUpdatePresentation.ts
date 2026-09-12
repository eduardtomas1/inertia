import type { AppUpdateStatus } from "@shared/desktop";

export type UpdateAction = "check" | "download" | "install" | "release" | "none";
export type UpdateIconState = "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "attention";

export function updatePresentation(status: AppUpdateStatus | null, checking: boolean): {
  icon: UpdateIconState; action: UpdateAction; label: string; actionLabel: string;
} {
  const state = status?.state;
  if (state === "installing") return { icon: "installing", action: "none", label: "Preparing a safe restart…", actionLabel: "Preparing restart…" };
  if (state === "downloading") return { icon: "downloading", action: "none",
    label: `Downloading update${updatePercent(status?.progress?.percent) === null ? "…" : ` (${updatePercent(status?.progress?.percent)}%)`}`, actionLabel: "Downloading…" };
  if (status?.installBlocker === "shutdown") return { icon: "attention", action: "none", label: "Update restart needs attention", actionLabel: "Reopen Inertia before retrying" };
  if (state === "downloaded") return { icon: status?.installBlocker ? "attention" : "downloaded", action: status?.latestVersion ? "install" : "none",
    label: status?.installBlocker ? "Update restart needs attention" : `Update ${status?.latestVersion ?? ""} ready to install`, actionLabel: "Restart to update" };
  if (checking || state === "checking") return { icon: "checking", action: "none", label: "Checking for updates…", actionLabel: "Checking…" };
  if (status?.latestVersion && ["available", "cancelled", "failed"].includes(state ?? "")) {
    const manual = status.delivery === "manual";
    return { icon: state === "failed" ? "attention" : "available",
      action: manual ? status.releaseUrl ? "release" : "check" : "download",
      label: state === "failed" ? "Update download failed — retry" : state === "cancelled" ? "Update download cancelled — retry"
        : `Update ${status.latestVersion} ${manual ? "available on the release page" : "ready to download"}`,
      actionLabel: manual ? status.releaseUrl ? "View release" : "Check for updates" : state === "available" ? "Download update" : "Retry download" };
  }
  return { icon: state === "unavailable" || state === "failed" ? "attention" : "idle", action: "check",
    label: state === "current" ? "Up to date — check again" : state === "unavailable" || state === "failed"
      ? "Could not check for updates — retry" : "Check for updates", actionLabel: "Check for updates" };
}

export function updatePercent(percent: number | undefined): number | null {
  return percent === undefined || !Number.isFinite(percent) ? null : Math.round(Math.min(100, Math.max(0, percent)));
}
