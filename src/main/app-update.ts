import type {
  AppUpdateDeliveryReason,
  AppUpdateInstallBlocker,
  AppUpdateProgress,
  AppUpdateStatus,
} from "../shared/desktop.js";
import type { AppUpdaterAdapter, AppUpdaterDownload } from "./electron-app-updater.js";

const LATEST_RELEASE_URL =
  "https://api.github.com/repos/eduardtomas1/inertia/releases/latest";
const RELEASE_PAGE_PREFIX =
  "https://github.com/eduardtomas1/inertia/releases/tag/v";
const DEFAULT_CACHE_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export type AppUpdateCapability =
  | { delivery: "in-app" }
  | { delivery: "manual"; reason: AppUpdateDeliveryReason };

export interface AppUpdateServiceOptions {
  currentVersion: string;
  fetch: typeof globalThis.fetch;
  capability?: AppUpdateCapability;
  loadUpdater?: () => Promise<AppUpdaterAdapter>;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

interface CachedCheck {
  state: "available" | "current";
  latestVersion: string;
  releaseUrl: string;
  checkedAt: string;
  message: string;
}

interface DownloadOperation {
  native: AppUpdaterDownload | null;
  cancelled: boolean;
  promise: Promise<AppUpdateStatus>;
}

function parsedVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  const values = match.slice(1).map(Number);
  if (values.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    return null;
  }
  const [major, minor, patch] = values as [number, number, number];
  return { major, minor, patch, text: `${major}.${minor}.${patch}` };
}

export function compareAppVersions(left: string, right: string): number {
  const leftVersion = parsedVersion(left);
  const rightVersion = parsedVersion(right);
  if (!leftVersion || !rightVersion) {
    throw new Error("Inertia update versions must use major.minor.patch.");
  }
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = leftVersion[key] - rightVersion[key];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("The update response was too large.");
  }
  if (!response.body) throw new Error("The update response was empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel("The update response was too large.");
        throw new Error("The update response was too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function latestTag(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The update response was invalid.");
  }
  const tag = parsedVersion((value as { tag_name?: unknown }).tag_name);
  if (!tag) throw new Error("The latest release tag was invalid.");
  return tag.text;
}

function normalizedProgress(progress: {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}): AppUpdateProgress | null {
  const values = [
    progress.percent,
    progress.transferred,
    progress.total,
    progress.bytesPerSecond,
  ];
  if (!values.every((value) => Number.isFinite(value) && value >= 0) || progress.total <= 0) {
    return null;
  }
  const totalBytes = Math.max(0, Math.trunc(progress.total));
  const transferredBytes = Math.min(totalBytes, Math.max(0, Math.trunc(progress.transferred)));
  return {
    percent: Math.min(100, Math.max(0, progress.percent)),
    transferredBytes,
    totalBytes,
    bytesPerSecond: Math.max(0, Math.trunc(progress.bytesPerSecond)),
  };
}

function snapshot(status: AppUpdateStatus): AppUpdateStatus {
  return {
    ...status,
    progress: status.progress ? { ...status.progress } : null,
  };
}

export class AppUpdateService {
  private readonly currentVersion: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly capability: AppUpdateCapability;
  private readonly loadUpdater: (() => Promise<AppUpdaterAdapter>) | null;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly listeners = new Set<(status: AppUpdateStatus) => void>();
  private status: AppUpdateStatus;
  private cached: CachedCheck | null = null;
  private checkInFlight: Promise<AppUpdateStatus> | null = null;
  private updaterPromise: Promise<AppUpdaterAdapter> | null = null;
  private downloadOperation: DownloadOperation | null = null;

  constructor(options: AppUpdateServiceOptions) {
    const current = parsedVersion(options.currentVersion);
    if (!current) throw new Error("The current Inertia version is invalid.");
    this.currentVersion = current.text;
    this.fetch = options.fetch;
    this.capability = options.capability ?? {
      delivery: "manual",
      reason: "development-build",
    };
    this.loadUpdater = options.loadUpdater ?? null;
    if (this.capability.delivery === "in-app" && !this.loadUpdater) {
      throw new Error("An in-app update build requires an updater adapter.");
    }
    this.now = options.now ?? Date.now;
    this.cacheMs = Math.max(60_000, options.cacheMs ?? DEFAULT_CACHE_MS);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.status = {
      revision: 0,
      state: "idle",
      freshness: "unavailable",
      delivery: this.capability.delivery,
      deliveryReason: this.capability.delivery === "manual" ? this.capability.reason : null,
      installBlocker: null,
      progress: null,
      currentVersion: this.currentVersion,
      latestVersion: null,
      releaseUrl: null,
      checkedAt: null,
      lastAttemptedAt: null,
      message: this.capability.delivery === "in-app"
        ? "Inertia will check for updates shortly."
        : "Inertia will check for releases shortly; this installation updates manually.",
    };
  }

  current(): AppUpdateStatus {
    return snapshot(this.status);
  }

  subscribe(listener: (status: AppUpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  check(force = false): Promise<AppUpdateStatus> {
    if (["downloading", "downloaded", "installing"].includes(this.status.state)) {
      return Promise.resolve(this.current());
    }
    const now = this.now();
    if (!force && this.cached && now - Date.parse(this.cached.checkedAt) < this.cacheMs) {
      return Promise.resolve(this.publish({
        ...this.cached,
        freshness: "cached",
        installBlocker: null,
        progress: null,
      }));
    }
    if (this.checkInFlight) return this.checkInFlight;
    const lastAttemptedAt = new Date(now).toISOString();
    this.publish({
      state: "checking",
      lastAttemptedAt,
      installBlocker: null,
      progress: null,
      message: "Checking for an Inertia update…",
    });
    const request = this.request(lastAttemptedAt).finally(() => {
      if (this.checkInFlight === request) this.checkInFlight = null;
    });
    this.checkInFlight = request;
    return request;
  }

  download(): Promise<AppUpdateStatus> {
    if (this.capability.delivery !== "in-app") {
      return Promise.resolve(this.publish({
        message: "Open the release page to update this installation manually.",
      }));
    }
    if (this.downloadOperation) {
      if (this.status.state === "cancelled") {
        return this.downloadOperation.promise.then(() => this.download());
      }
      return this.downloadOperation.promise;
    }
    if (
      !this.status.latestVersion
      || !["available", "cancelled", "failed"].includes(this.status.state)
    ) {
      return Promise.reject(new Error("No checked update is ready to download."));
    }
    this.publish({
      state: "downloading",
      installBlocker: null,
      progress: null,
      message: `Downloading Inertia ${this.status.latestVersion}…`,
    });
    const operation: DownloadOperation = {
      native: null,
      cancelled: false,
      promise: Promise.resolve(this.current()),
    };
    const promise = this.runDownload(operation).finally(() => {
      if (this.downloadOperation === operation) this.downloadOperation = null;
    });
    operation.promise = promise;
    this.downloadOperation = operation;
    return promise;
  }

  cancelDownload(): AppUpdateStatus {
    const operation = this.downloadOperation;
    if (!operation || this.status.state !== "downloading") return this.current();
    operation.cancelled = true;
    operation.native?.cancel();
    return this.publish({
      state: "cancelled",
      progress: null,
      message: "The update download was cancelled.",
    });
  }

  beginInstall(): AppUpdateStatus {
    if (this.status.state !== "downloaded") {
      throw new Error("The update has not finished downloading.");
    }
    return this.publish({
      state: "installing",
      installBlocker: null,
      progress: null,
      message: "Preparing Inertia to restart safely…",
    });
  }

  blockInstall(blocker: AppUpdateInstallBlocker): AppUpdateStatus {
    if (this.status.state !== "installing") return this.current();
    const details: Record<AppUpdateInstallBlocker, string> = {
      "active-work": "Finish active agent work before restarting to update.",
      terminal: "Close active terminals before restarting to update.",
      maintenance: "Wait for provider maintenance to finish before restarting.",
      "database-recovery": "Wait for database recovery to finish before restarting.",
      "local-operation": "Wait for local workspace operations to finish before restarting.",
      "runtime-transition": "Wait for the local runtime to become ready before restarting.",
      "private-connect": "Disconnect active Private Connect sessions before restarting.",
      shutdown: "Inertia could not confirm a safe shutdown. Reopen the app before retrying.",
    };
    return this.publish({
      state: "downloaded",
      installBlocker: blocker,
      message: details[blocker],
    });
  }

  failInstall(): AppUpdateStatus {
    if (this.status.state !== "installing") return this.current();
    return this.publish({
      state: "failed",
      installBlocker: "shutdown",
      message: "Inertia could not confirm a safe shutdown. Reopen the app before retrying.",
    });
  }

  async quitAndInstall(onHandoff?: () => void): Promise<boolean> {
    if (this.status.state !== "installing") {
      throw new Error("The update installation is not prepared.");
    }
    return await (await this.updater()).quitAndInstall(onHandoff);
  }

  private async request(lastAttemptedAt: string): Promise<AppUpdateStatus> {
    try {
      const native = this.capability.delivery === "in-app"
        ? await this.nativeLatestVersion()
        : null;
      const latestVersion = native?.version ?? await this.manualLatestVersion();
      const checkedAt = new Date(this.now()).toISOString();
      const available = (native?.available ?? true)
        && compareAppVersions(latestVersion, this.currentVersion) > 0;
      const cached: CachedCheck = {
        state: available ? "available" : "current",
        latestVersion,
        releaseUrl: `${RELEASE_PAGE_PREFIX}${latestVersion}`,
        checkedAt,
        message: available
          ? `Inertia ${latestVersion} is available.`
          : "Inertia is up to date.",
      };
      this.cached = cached;
      return this.publish({
        ...cached,
        freshness: "fresh",
        lastAttemptedAt,
        installBlocker: null,
        progress: null,
      });
    } catch {
      if (this.cached) {
        return this.publish({
          ...this.cached,
          freshness: "cached",
          lastAttemptedAt,
          installBlocker: null,
          progress: null,
          message: `${this.cached.message} The latest check could not be completed.`,
        });
      }
      return this.publish({
        state: "unavailable",
        freshness: "unavailable",
        latestVersion: null,
        releaseUrl: null,
        checkedAt: null,
        lastAttemptedAt,
        installBlocker: null,
        progress: null,
        message: "Inertia could not check for updates right now.",
      });
    }
  }

  private async nativeLatestVersion(): Promise<{ available: boolean; version: string }> {
    const result = await (await this.updater()).check();
    const latest = parsedVersion(result?.version);
    if (!latest) throw new Error("The updater returned an invalid version.");
    return { available: result?.available === true, version: latest.text };
  }

  private async manualLatestVersion(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetch(LATEST_RELEASE_URL, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": `Inertia/${this.currentVersion}`,
        },
      });
      if (!response.ok) throw new Error(`Update request failed (${response.status}).`);
      return latestTag(await boundedJson(response));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runDownload(operation: DownloadOperation): Promise<AppUpdateStatus> {
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    try {
      const updater = await this.updater();
      if (operation.cancelled || this.downloadOperation !== operation) {
        return this.current();
      }
      const native = updater.download({
        onProgress: (progress) => {
          if (
            this.downloadOperation !== operation
            || operation.cancelled
            || this.status.state !== "downloading"
          ) return;
          const next = normalizedProgress(progress);
          if (!next) return;
          const progressAt = this.now();
          if (next.percent < 100 && progressAt - lastProgressAt < 250) return;
          lastProgressAt = progressAt;
          this.publish({ progress: next });
        },
        onCancelled: () => {
          if (this.downloadOperation !== operation) return;
          operation.cancelled = true;
          if (this.status.state === "downloading") {
            this.publish({
              state: "cancelled",
              progress: null,
              message: "The update download was cancelled.",
            });
          }
        },
      });
      operation.native = native;
      if (operation.cancelled) {
        native.cancel();
        return this.current();
      }
      await native.promise;
      if (operation.cancelled || this.status.state === "cancelled") return this.current();
      if (this.downloadOperation !== operation) return this.current();
      return this.publish({
        state: "downloaded",
        progress: null,
        installBlocker: null,
        message: `Inertia ${this.status.latestVersion} is ready to install.`,
      });
    } catch {
      if (operation.cancelled) {
        if (this.status.state !== "cancelled") {
          return this.publish({
            state: "cancelled",
            progress: null,
            message: "The update download was cancelled.",
          });
        }
        return this.current();
      }
      return this.publish({
        state: "failed",
        progress: null,
        installBlocker: null,
        message: "The update could not be downloaded. Try again when your connection is stable.",
      });
    }
  }

  private updater(): Promise<AppUpdaterAdapter> {
    if (!this.loadUpdater) return Promise.reject(new Error("In-app updates are unavailable."));
    this.updaterPromise ??= this.loadUpdater();
    return this.updaterPromise;
  }

  private publish(update: Partial<AppUpdateStatus>): AppUpdateStatus {
    this.status = {
      ...this.status,
      ...update,
      revision: this.status.revision + 1,
    };
    const next = this.current();
    for (const listener of this.listeners) listener(next);
    return next;
  }
}
