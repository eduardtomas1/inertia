import type {
  ProviderMaintenanceFreshness,
} from "../../shared/provider-maintenance";
import {
  homebrewInfoArgs,
  homebrewLatestVersion,
  readHomebrewInfo,
  type HomebrewInfoReader,
} from "./maintenance-homebrew-latest";
import type { HomebrewLatestSource } from "./maintenance-install-source";

export const PROVIDER_CLI_RELEASE_COOLDOWN_MS = 72 * 60 * 60 * 1_000;
export const PROVIDER_CLI_RELEASE_COOLDOWN_HOURS =
  PROVIDER_CLI_RELEASE_COOLDOWN_MS / (60 * 60 * 1_000);

const DEFAULT_SUCCESS_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_FAILURE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_PACKUMENT_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 16;
const REGISTRY_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const PARTIAL_VERSION = /^\d+(?:\.\d+){0,2}$/u;

interface LatestVersionCacheEntry {
  version: string | null;
  heldVersion: string | null;
  checkedAt: number;
  expiresAt: number;
  lastError: string | null;
}

export interface LatestVersionResult {
  version: string | null;
  heldVersion: string | null;
  freshness: ProviderMaintenanceFreshness;
  checkedAt: string | null;
  error: string | null;
}

export interface ProviderReleaseSelection {
  version: string;
  heldVersion: string | null;
}

export interface ProviderLatestVersionCacheOptions {
  fetch?: typeof fetch;
  homebrewInfo?: HomebrewInfoReader;
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
}

export class ProviderReleaseCooldownError extends Error {
  constructor() {
    super(`No release has been public for at least ${PROVIDER_CLI_RELEASE_COOLDOWN_HOURS} hours yet.`);
    this.name = "ProviderReleaseCooldownError";
  }
}

function normalizedVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^v/u, "");
  return /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(trimmed)
    ? trimmed
    : null;
}

function publicFailure(error: unknown): string {
  if (error instanceof ProviderReleaseCooldownError) return error.message;
  if (error instanceof Error && error.name === "AbortError") {
    return "Latest-version check timed out.";
  }
  return "Latest-version information is temporarily unavailable.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrerelease(version: string): boolean {
  return version.split("+", 1)[0]!.includes("-");
}

function registrySpecMatcher(
  spec: string,
  distTags: unknown,
): ((version: string) => boolean) | null {
  if (PARTIAL_VERSION.test(spec)) {
    const parts = spec.split(".");
    return (version) => !isPrerelease(version)
      && version.split(".", parts.length).every((part, index) => part === parts[index]);
  }
  if (!DIST_TAG.test(spec) || !isRecord(distTags)) return null;
  const tagged = distTags[spec];
  if (typeof tagged !== "string" || !REGISTRY_VERSION.test(tagged)) return null;
  const prereleases = isPrerelease(tagged);
  return (version) => (prereleases || !isPrerelease(version))
    && (compareProviderVersions(version, tagged) ?? 1) <= 0;
}

export function selectProviderRelease(
  packument: unknown,
  spec: string,
  now: number,
): ProviderReleaseSelection {
  if (
    !isRecord(packument)
    || !isRecord(packument.versions)
    || !isRecord(packument.time)
  ) {
    throw new Error("registry response did not include release times");
  }
  const { versions, time } = packument;
  const matches = registrySpecMatcher(spec, packument["dist-tags"]);
  if (!matches) throw new Error("registry response did not resolve the package spec");
  const candidates = Object.keys(versions)
    .filter((version) => REGISTRY_VERSION.test(version) && matches(version))
    .sort((left, right) => compareProviderVersions(right, left) ?? 0);
  let heldVersion: string | null = null;
  for (const version of candidates) {
    const manifest = versions[version];
    if (
      !isRecord(manifest)
      || (typeof manifest.deprecated === "string" && manifest.deprecated.length > 0)
    ) continue;
    const published = typeof time[version] === "string"
      ? Date.parse(time[version])
      : Number.NaN;
    if (!Number.isFinite(published)) continue;
    if (now - published < PROVIDER_CLI_RELEASE_COOLDOWN_MS) {
      heldVersion ??= version;
      continue;
    }
    return { version, heldVersion };
  }
  throw new ProviderReleaseCooldownError();
}

async function boundedResponseText(
  response: Response,
  limit: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error("registry response exceeded the limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("registry response exceeded the limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export class ProviderLatestVersionCache {
  private readonly entries = new Map<string, LatestVersionCacheEntry>();
  private readonly requests = new Map<string, Promise<LatestVersionResult>>();
  private readonly fetchImplementation: typeof fetch;
  private readonly homebrewInfo: HomebrewInfoReader;
  private readonly now: () => number;
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;

  constructor(options: ProviderLatestVersionCacheOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.homebrewInfo = options.homebrewInfo ?? readHomebrewInfo;
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
      Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );
  }

  async latest(
    packageName: string,
    spec: string,
    force = false,
    signal?: AbortSignal,
  ): Promise<LatestVersionResult> {
    return await this.cached(
      `npm\0${packageName}\0${spec}`,
      force,
      async () => await this.fetchRelease(packageName, spec, signal),
      signal,
    );
  }

  async homebrew(
    source: HomebrewLatestSource,
    force = false,
  ): Promise<LatestVersionResult> {
    return await this.cached(
      `homebrew\0${source.brew}\0${source.cask ? "cask" : "formula"}\0${source.name}`,
      force,
      async () => {
        const json = await this.homebrewInfo(source.brew, homebrewInfoArgs(source));
        if (json === null) throw new Error("Homebrew did not report the release");
        const version = normalizedVersion(homebrewLatestVersion(json, source.cask));
        if (!version) throw new Error("Homebrew did not report a version");
        return { version, heldVersion: null };
      },
    );
  }

  private async cached(
    key: string,
    force: boolean,
    read: () => Promise<ProviderReleaseSelection>,
    signal?: AbortSignal,
  ): Promise<LatestVersionResult> {
    signal?.throwIfAborted();
    const now = this.now();
    const cached = this.entries.get(key);
    if (!force && cached && cached.expiresAt > now) {
      return this.result(cached, cached.lastError ? "stale" : "fresh");
    }
    if (signal) return await this.resolve(key, cached, read, signal);
    const active = this.requests.get(key);
    if (active) return await active;
    const request = this.resolve(key, cached, read)
      .finally(() => this.requests.delete(key));
    this.requests.set(key, request);
    return await request;
  }

  private async resolve(
    key: string,
    previous: LatestVersionCacheEntry | undefined,
    read: () => Promise<ProviderReleaseSelection>,
    signal?: AbortSignal,
  ): Promise<LatestVersionResult> {
    try {
      const { version, heldVersion } = await read();
      const checkedAt = this.now();
      const entry: LatestVersionCacheEntry = {
        version,
        heldVersion,
        checkedAt,
        expiresAt: checkedAt + this.successTtlMs,
        lastError: null,
      };
      this.remember(key, entry);
      return this.result(entry, "fresh");
    } catch (error) {
      if (signal?.aborted) throw error;
      const checkedAt = this.now();
      const entry: LatestVersionCacheEntry = {
        version: previous?.version ?? null,
        heldVersion: previous?.heldVersion ?? null,
        checkedAt: previous?.checkedAt ?? checkedAt,
        expiresAt: checkedAt + this.failureTtlMs,
        lastError: publicFailure(error),
      };
      this.remember(key, entry);
      return this.result(
        entry,
        entry.version ? "stale" : "unavailable",
      );
    }
  }

  private async fetchRelease(
    packageName: string,
    spec: string,
    signal?: AbortSignal,
  ): Promise<ProviderReleaseSelection> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImplementation(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
        {
          signal: signal
            ? AbortSignal.any([controller.signal, signal])
            : controller.signal,
          headers: { accept: "application/json" },
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error("registry response failed");
      const text = await boundedResponseText(response, MAX_PACKUMENT_BYTES);
      const served = Date.parse(response.headers.get("date") ?? "");
      return selectProviderRelease(
        JSON.parse(text),
        spec,
        Number.isFinite(served) ? Math.min(this.now(), served) : this.now(),
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
      heldVersion: entry.heldVersion,
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
