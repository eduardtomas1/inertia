import type { ProviderMaintenanceOperation, ProviderMaintenanceProviderId } from "@shared/contracts";
import type { AppUpdateStatus } from "@shared/desktop";
import type { UpdateEverythingActiveRun } from "../../hooks/useUpdateEverything";
import type { UpdateEverythingOutcome, UpdateEverythingPhase } from "../../utils/updateEverythingRun";
import { updatePercent } from "./appUpdatePresentation";

export type UpdateStripTone = "loading" | "success" | "warning" | "error";
export type UpdateStripIcon = "download" | "loading" | "restart" | "done" | "alert";

export interface UpdateStripItem {
  id: string;
  label: string;
  status: string;
  detail: string | null;
  failed: boolean;
}

export interface UpdateStripView {
  key: string;
  active: boolean;
  tone: UpdateStripTone;
  icon: UpdateStripIcon;
  title: string;
  meta: string | null;
  slow: boolean;
  progress: number | null;
  dismissible: boolean;
  autoDismiss: boolean;
  action: "restart" | null;
  items: UpdateStripItem[];
}

export interface UpdateStripInput {
  phase: UpdateEverythingPhase | null;
  activeRun: UpdateEverythingActiveRun | null;
  outcome: UpdateEverythingOutcome | null;
  operations: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceOperation>;
  appStatus: AppUpdateStatus | null;
  label: (providerId: ProviderMaintenanceProviderId) => string;
  now: number;
  watermark: number;
  dismissed: ReadonlySet<string>;
  downloadedVersion: string | null;
}

const SLOW_AFTER_MS = 3 * 60 * 1_000;
const TONE_RANK: Record<UpdateStripTone, number> = { loading: 0, error: 1, warning: 2, success: 3 };

function time(value: string | null): number {
  const parsed = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function formatUpdateElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function active(operation: ProviderMaintenanceOperation | undefined): boolean {
  return operation?.status === "queued" || operation?.status === "running";
}

function joinNames(names: readonly string[], noun: string, singular: string, plural: string): string {
  if (names.length === 1) return `${names[0]} ${singular}`;
  if (names.length === 2) return `${names[0]} and ${names[1]} ${plural}`;
  return `${names.length} ${noun} ${plural}`;
}

function operationStatus(operation: ProviderMaintenanceOperation | undefined, now: number): Pick<UpdateStripItem, "status" | "detail" | "failed"> {
  if (!operation || operation.status === "queued") return { status: "Queued", detail: null, failed: false };
  if (operation.status === "running") {
    const started = time(operation.startedAt);
    return { status: Number.isFinite(started) ? `Updating · ${formatUpdateElapsed(now - started)}` : "Updating", detail: null, failed: false };
  }
  if (operation.status === "succeeded") {
    return { status: operation.afterVersion ? `Updated to ${operation.afterVersion}` : "Updated", detail: null, failed: false };
  }
  if (operation.status === "unchanged") return { status: "Unchanged", detail: operation.message || null, failed: false };
  if (operation.status === "cancelled") return { status: "Cancelled", detail: null, failed: false };
  return { status: "Failed", detail: operation.message || null, failed: true };
}

function appItem(input: UpdateStripInput): UpdateStripItem | null {
  const { phase, activeRun, appStatus } = input;
  if (!activeRun?.includeApp && phase?.kind !== "download" && phase?.kind !== "app") return null;
  const percent = updatePercent(appStatus?.progress?.percent);
  const status = phase?.kind === "app" ? "Restarting…"
    : appStatus?.state === "downloading" ? `Downloading${percent === null ? "" : ` · ${percent}%`}`
      : appStatus?.state === "downloaded" ? "Downloaded · restarts after providers"
        : "Waiting";
  return { id: "inertia", label: "Inertia", status, detail: null, failed: false };
}

function runOperation(input: UpdateStripInput, providerId: ProviderMaintenanceProviderId, since: number): ProviderMaintenanceOperation | undefined {
  const operation = input.operations.get(providerId);
  if (!operation) return undefined;
  if (active(operation)) return operation;
  const finished = time(operation.finishedAt);
  return Number.isFinite(finished) && finished >= since ? operation : undefined;
}

function activeView(input: UpdateStripInput): UpdateStripView | null {
  const { phase, activeRun, appStatus, operations, label, now } = input;
  const percent = updatePercent(appStatus?.progress?.percent);
  const base = { active: true, tone: "loading" as const, dismissible: false, autoDismiss: false, action: null };
  const runProviders = activeRun?.providerIds ?? (phase?.kind === "providers" ? phase.providerIds : []);
  const runItems = (): UpdateStripItem[] => {
    const app = appItem(input);
    return [...(app ? [app] : []), ...runProviders.map((providerId) => ({
      id: providerId, label: label(providerId), ...operationStatus(runOperation(input, providerId, activeRun?.startedAt ?? 0), now),
    }))];
  };
  if (phase?.kind === "download" || (!phase && appStatus?.state === "downloading")) {
    return { ...base, key: "active:download", icon: "download",
      title: appStatus?.latestVersion ? `Downloading Inertia ${appStatus.latestVersion}…` : "Downloading Inertia…",
      meta: percent === null ? null : `${percent}%`, slow: false, progress: percent === null ? 0 : percent / 100,
      items: phase ? runItems() : [] };
  }
  if (phase?.kind === "app" || (!phase && appStatus?.state === "installing")) {
    return { ...base, key: "active:app", icon: "restart", title: "Preparing Inertia to restart…", meta: null, slow: false,
      progress: null, items: phase ? runItems() : [] };
  }
  const providerIds = phase?.kind === "providers" ? phase.providerIds
    : [...operations.values()].filter(active).map((operation) => operation.providerId);
  if (providerIds.length === 0) return null;
  const since = activeRun?.startedAt ?? Math.min(...providerIds.map((providerId) => time(operations.get(providerId)?.startedAt ?? null))
    .filter(Number.isFinite), now);
  const current = providerIds.find((providerId) => operations.get(providerId)?.status === "running")
    ?? providerIds.find((providerId) => active(operations.get(providerId)))
    ?? providerIds[0]!;
  const runningSince = time(operations.get(current)?.status === "running" ? operations.get(current)!.startedAt : null);
  const slow = Number.isFinite(runningSince) && now - runningSince >= SLOW_AFTER_MS;
  const standaloneTotal = phase ? providerIds : [...operations.values()].filter((operation) => active(operation)
    || (Number.isFinite(time(operation.finishedAt)) && time(operation.finishedAt) >= since && operation.status !== "cancelled"))
    .map((operation) => operation.providerId);
  const done = standaloneTotal.filter((providerId) => {
    const operation = runOperation(input, providerId, since);
    return operation !== undefined && !active(operation);
  }).length;
  const meta = slow ? formatUpdateElapsed(now - runningSince)
    : standaloneTotal.length > 1 ? `${done} of ${standaloneTotal.length}` : null;
  const items = phase ? runItems() : standaloneTotal.map((providerId) => ({
    id: providerId, label: label(providerId), ...operationStatus(runOperation(input, providerId, since), now),
  }));
  return { ...base, key: `active:providers:${[...providerIds].sort().join(",")}`, icon: "loading",
    title: `Updating ${label(current)}…`, meta, slow, progress: null, items };
}

function outcomeView(input: UpdateStripInput): UpdateStripView | null {
  const { outcome, label } = input;
  if (!outcome) return null;
  const key = `result:${outcome.startedAt}`;
  const items: UpdateStripItem[] = outcome.app === "threw" ? [] : [
    ...(outcome.app === "not-included" ? [] : [{ id: "inertia", label: "Inertia",
      status: outcome.app === "installed" ? "Restarting…" : outcome.app === "restart-refused" ? "Ready to restart" : "Failed",
      detail: outcome.appMessage, failed: outcome.app === "download-failed" }]),
    ...outcome.providers.map((provider) => ({
      id: provider.providerId, label: label(provider.providerId),
      status: provider.outcome === "updated" ? provider.afterVersion ? `Updated to ${provider.afterVersion}` : "Updated"
        : provider.outcome === "unchanged" ? "Unchanged" : provider.outcome === "skipped" ? "Skipped" : "Failed",
      detail: provider.outcome === "failed" ? provider.error : null, failed: provider.outcome === "failed",
    })),
  ];
  const view = (tone: UpdateStripTone, icon: UpdateStripIcon, title: string): UpdateStripView => ({
    key, active: false, tone, icon, title, meta: null, slow: false, progress: null,
    dismissible: tone !== "success", autoDismiss: tone === "success", action: null, items,
  });
  const names = (kind: UpdateEverythingOutcome["providers"][number]["outcome"]) =>
    outcome.providers.filter((provider) => provider.outcome === kind).map((provider) => label(provider.providerId));
  if (outcome.app === "threw") return view("error", "alert", "Update couldn’t finish");
  const failed = names("failed");
  if (failed.length > 0) return view("error", "alert", failed.length === 1 ? `${failed[0]} update failed` : `${failed.length} provider updates failed`);
  if (outcome.app === "download-failed") return view("error", "alert", "Inertia download failed");
  const unchanged = names("unchanged");
  if (unchanged.length > 0) return view("warning", "alert", unchanged.length === 1
    ? `${unchanged[0]} still needs an update` : `${unchanged.length} providers still need updates`);
  if (outcome.app === "restart-refused" && outcome.appMessage) return view("warning", "alert", "Inertia is ready to restart");
  const updated = outcome.providers.filter((provider) => provider.outcome === "updated");
  if (updated.length === 0) return null;
  if (updated.length === 1) {
    const [provider] = updated;
    return view("success", "done", provider!.afterVersion
      ? `${label(provider!.providerId)} updated to ${provider!.afterVersion}` : `${label(provider!.providerId)} updated`);
  }
  return view("success", "done", joinNames(updated.map((provider) => label(provider.providerId)), "providers", "updated", "updated"));
}

function operationsView(input: UpdateStripInput): UpdateStripView | null {
  const { operations, outcome, label, watermark, dismissed, now } = input;
  const finished = [...operations.values()].filter((operation) => {
    const at = time(operation.finishedAt);
    if (!Number.isFinite(at) || at <= watermark) return false;
    if (operation.status !== "succeeded" && operation.status !== "unchanged" && operation.status !== "failed") return false;
    if (outcome && at >= outcome.startedAt && outcome.providers.some((provider) => provider.providerId === operation.providerId)) return false;
    return !dismissed.has(`op:${operation.id}:${operation.finishedAt}:${operation.status}`);
  });
  if (finished.length === 0) return null;
  const key = finished.map((operation) => `op:${operation.id}:${operation.finishedAt}:${operation.status}`).sort().join("|");
  const items = finished.map((operation) => ({ id: operation.providerId, label: label(operation.providerId), ...operationStatus(operation, now) }));
  const view = (tone: UpdateStripTone, icon: UpdateStripIcon, title: string): UpdateStripView => ({
    key, active: false, tone, icon, title, meta: null, slow: false, progress: null,
    dismissible: tone !== "success", autoDismiss: tone === "success", action: null, items,
  });
  const named = (status: ProviderMaintenanceOperation["status"]) => finished.filter((operation) => operation.status === status);
  const failed = named("failed");
  if (failed.length > 0) return view("error", "alert", failed.length === 1 ? `${label(failed[0]!.providerId)} update failed` : `${failed.length} provider updates failed`);
  const unchanged = named("unchanged");
  if (unchanged.length > 0) return view("warning", "alert", unchanged.length === 1
    ? `${label(unchanged[0]!.providerId)} still needs an update` : `${unchanged.length} providers still need updates`);
  const updated = named("succeeded");
  if (updated.length === 1) {
    const [operation] = updated;
    return view("success", "done", operation!.afterVersion
      ? `${label(operation!.providerId)} updated to ${operation!.afterVersion}` : `${label(operation!.providerId)} updated`);
  }
  return view("success", "done", joinNames(updated.map((operation) => label(operation.providerId)), "providers", "updated", "updated"));
}

function downloadedView(input: UpdateStripInput): UpdateStripView | null {
  const { appStatus, downloadedVersion } = input;
  if (input.phase || appStatus?.state !== "downloaded" || !appStatus.latestVersion || appStatus.latestVersion !== downloadedVersion) return null;
  if (appStatus.installBlocker) return null;
  return { key: `downloaded:${appStatus.latestVersion}`, active: false, tone: "success", icon: "done",
    title: `Inertia ${appStatus.latestVersion} downloaded`, meta: null, slow: false, progress: null,
    dismissible: false, autoDismiss: true, action: "restart", items: [] };
}

export function updateStripView(input: UpdateStripInput): UpdateStripView | null {
  const current = activeView(input);
  if (current) return current;
  const candidates = [outcomeView(input), operationsView(input), downloadedView(input)]
    .filter((view): view is UpdateStripView => view !== null && !input.dismissed.has(view.key));
  return candidates.sort((left, right) => TONE_RANK[left.tone] - TONE_RANK[right.tone])[0] ?? null;
}
