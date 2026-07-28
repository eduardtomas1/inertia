import type { AppUpdateStatus } from "../shared/desktop.js";

const LATEST_RELEASE_URL =
  "https://api.github.com/repos/eduardtomas1/inertia/releases/latest";
const RELEASE_PAGE_PREFIX =
  "https://github.com/eduardtomas1/inertia/releases/tag/v";
const DEFAULT_CACHE_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export interface AppUpdateServiceOptions {
  currentVersion: string;
  fetch: typeof globalThis.fetch;
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

function unavailableStatus(
  currentVersion: string,
  attemptedAt: string,
): AppUpdateStatus {
  return {
    state: "unavailable",
    freshness: "unavailable",
    currentVersion,
    latestVersion: null,
    releaseUrl: null,
    checkedAt: null,
    lastAttemptedAt: attemptedAt,
    message: "Inertia could not check for updates right now.",
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("The update response was too large.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("The update response was too large.");
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

export class AppUpdateService {
  private readonly currentVersion: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private cached: AppUpdateStatus | null = null;
  private inFlight: Promise<AppUpdateStatus> | null = null;

  constructor(options: AppUpdateServiceOptions) {
    const current = parsedVersion(options.currentVersion);
    if (!current) throw new Error("The current Inertia version is invalid.");
    this.currentVersion = current.text;
    this.fetch = options.fetch;
    this.now = options.now ?? Date.now;
    this.cacheMs = Math.max(60_000, options.cacheMs ?? DEFAULT_CACHE_MS);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  check(force = false): Promise<AppUpdateStatus> {
    const now = this.now();
    if (
      !force
      && this.cached?.checkedAt
      && now - Date.parse(this.cached.checkedAt) < this.cacheMs
    ) {
      return Promise.resolve({ ...this.cached, freshness: "cached" });
    }
    if (this.inFlight) return this.inFlight;
    const request = this.request(now).finally(() => {
      if (this.inFlight === request) this.inFlight = null;
    });
    this.inFlight = request;
    return request;
  }

  private async request(attemptedAtMs: number): Promise<AppUpdateStatus> {
    const lastAttemptedAt = new Date(attemptedAtMs).toISOString();
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
      const latestVersion = latestTag(await boundedJson(response));
      const checkedAt = new Date(this.now()).toISOString();
      const available = compareAppVersions(latestVersion, this.currentVersion) > 0;
      const status: AppUpdateStatus = {
        state: available ? "available" : "current",
        freshness: "fresh",
        currentVersion: this.currentVersion,
        latestVersion,
        releaseUrl: `${RELEASE_PAGE_PREFIX}${latestVersion}`,
        checkedAt,
        lastAttemptedAt,
        message: available
          ? `Inertia ${latestVersion} is available.`
          : "Inertia is up to date.",
      };
      this.cached = status;
      return status;
    } catch {
      if (this.cached) {
        return {
          ...this.cached,
          freshness: "cached",
          lastAttemptedAt,
          message: `${this.cached.message} The latest check could not be completed.`,
        };
      }
      return unavailableStatus(this.currentVersion, lastAttemptedAt);
    } finally {
      clearTimeout(timeout);
    }
  }
}
