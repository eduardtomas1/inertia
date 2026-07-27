import type {
  ProviderMaintenanceFreshness,
} from "../../shared/provider-maintenance";

const DEFAULT_SUCCESS_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_FAILURE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_CACHE_ENTRIES = 16;

interface LatestVersionCacheEntry {
  version: string | null;
  checkedAt: number;
  expiresAt: number;
  lastError: string | null;
}

export interface LatestVersionResult {
  version: string | null;
  freshness: ProviderMaintenanceFreshness;
  checkedAt: string | null;
  error: string | null;
}

export interface ProviderLatestVersionCacheOptions {
  fetch?: typeof fetch;
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
}

function normalizedVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^v/u, "");
  return /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(trimmed)
    ? trimmed
    : null;
}

function publicFailure(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Latest-version check timed out.";
  }
  return "Latest-version information is temporarily unavailable.";
}

export class ProviderLatestVersionCache {
  private readonly entries = new Map<string, LatestVersionCacheEntry>();
  private readonly requests = new Map<string, Promise<LatestVersionResult>>();
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;

  constructor(options: ProviderLatestVersionCacheOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.successTtlMs = Math.max(
      60_000,
      options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS,
    );
    this.failureTtlMs = Math.max(
      10_000,
      options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS,
    );
    this.timeoutMs = Math.max(
      250,
      Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000),
    );
  }

  async latest(packageName: string, force = false): Promise<LatestVersionResult> {
    const now = this.now();
    const cached = this.entries.get(packageName);
    if (!force && cached && cached.expiresAt > now) {
      return this.result(cached, cached.lastError ? "stale" : "fresh");
    }
    const active = this.requests.get(packageName);
    if (active) return await active;
    const request = this.fetchLatest(packageName, cached)
      .finally(() => this.requests.delete(packageName));
    this.requests.set(packageName, request);
    return await request;
  }

  private async fetchLatest(
    packageName: string,
    previous: LatestVersionCacheEntry | undefined,
  ): Promise<LatestVersionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImplementation(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
        {
          signal: controller.signal,
          headers: { accept: "application/json" },
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error("registry response failed");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error("registry response exceeded the limit");
      }
      const parsed = JSON.parse(text) as { version?: unknown };
      const version = normalizedVersion(parsed.version);
      if (!version) throw new Error("registry response did not include a version");
      const checkedAt = this.now();
      const entry: LatestVersionCacheEntry = {
        version,
        checkedAt,
        expiresAt: checkedAt + this.successTtlMs,
        lastError: null,
      };
      this.remember(packageName, entry);
      return this.result(entry, "fresh");
    } catch (error) {
      const checkedAt = this.now();
      const entry: LatestVersionCacheEntry = {
        version: previous?.version ?? null,
        checkedAt: previous?.checkedAt ?? checkedAt,
        expiresAt: checkedAt + this.failureTtlMs,
        lastError: publicFailure(error),
      };
      this.remember(packageName, entry);
      return this.result(
        entry,
        entry.version ? "stale" : "unavailable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(packageName: string, entry: LatestVersionCacheEntry): void {
    this.entries.delete(packageName);
    this.entries.set(packageName, entry);
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }

  private result(
    entry: LatestVersionCacheEntry,
    freshness: ProviderMaintenanceFreshness,
  ): LatestVersionResult {
    return {
      version: entry.version,
      freshness,
      checkedAt: Number.isFinite(entry.checkedAt)
        ? new Date(entry.checkedAt).toISOString()
        : null,
      error: entry.lastError,
    };
  }
}

interface ParsedSemver {
  core: number[];
  prerelease: Array<number | string>;
}

function parseSemver(value: string | null): ParsedSemver | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^v/u, "").split("+", 1)[0]!;
  const [core, prerelease = ""] = normalized.split("-", 2);
  if (!/^\d+(?:\.\d+){1,2}$/u.test(core)) return null;
  return {
    core: core.split(".").map(Number),
    prerelease: prerelease
      ? prerelease.split(".").map((part) => /^\d+$/u.test(part) ? Number(part) : part)
      : [],
  };
}

export function compareProviderVersions(
  left: string | null,
  right: string | null,
): number | null {
  const leftVersion = parseSemver(left);
  const rightVersion = parseSemver(right);
  if (!leftVersion || !rightVersion) return null;
  for (
    let index = 0;
    index < Math.max(leftVersion.core.length, rightVersion.core.length);
    index += 1
  ) {
    const difference = (
      leftVersion.core[index] ?? 0
    ) - (
      rightVersion.core[index] ?? 0
    );
    if (difference !== 0) return difference;
  }
  if (
    leftVersion.prerelease.length === 0
    || rightVersion.prerelease.length === 0
  ) {
    return leftVersion.prerelease.length === rightVersion.prerelease.length
      ? 0
      : leftVersion.prerelease.length === 0 ? 1 : -1;
  }
  for (
    let index = 0;
    index < Math.max(
      leftVersion.prerelease.length,
      rightVersion.prerelease.length,
    );
    index += 1
  ) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return leftPart - rightPart;
    }
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart.localeCompare(rightPart, "en-US");
  }
  return 0;
}
