import { access } from "node:fs/promises";

export const ANTIGRAVITY_CLI_MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

const ANTIGRAVITY_CLI_GCS_PREFIX =
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SHA512_PATTERN = /^[a-fA-F0-9]{128}$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export interface AntigravityCliReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
  readonly executableName: string;
  readonly format: "tar.gz" | "executable";
}

export interface FetchLatestAntigravityReleaseOptions {
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  musl?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function antigravityCliTarget(
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): string | null {
  if (
    (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    || (arch !== "x64" && arch !== "arm64")
  ) {
    return null;
  }
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "amd64" : "arm64";
  const suffix = platform === "linux" && musl ? "_musl" : "";
  return `${os}_${cpu}${suffix}`;
}

export function antigravityManifestUrl(
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): string | null {
  const target = antigravityCliTarget(platform, arch, musl);
  return target ? `${ANTIGRAVITY_CLI_MANIFEST_BASE}/${target}.json` : null;
}

export function parseAntigravityCliRelease(
  value: unknown,
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityCliReleaseAsset | null {
  if (!isRecord(value) || antigravityCliTarget(platform, arch, musl) === null) {
    return null;
  }
  const { version, url, sha512 } = value;
  if (
    typeof version !== "string"
    || !VERSION_PATTERN.test(version)
    || typeof sha512 !== "string"
    || !SHA512_PATTERN.test(sha512)
    || typeof url !== "string"
  ) {
    return null;
  }

  const os = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  const cpu = arch === "x64" ? "x64" : "arm64";
  const suffix = platform === "linux" && musl ? "_musl" : "";
  const extension = platform === "win32" ? "exe" : "tar.gz";
  const folder = `${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "arm" : "x64"}${suffix ? "-musl" : ""}`;
  const prefix = `${ANTIGRAVITY_CLI_GCS_PREFIX}${version}-`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (
    !/^\d+\//u.test(rest)
    || rest.replace(/^\d+\//u, "") !== `${folder}/cli_${os}_${cpu}${suffix}.${extension}`
  ) {
    return null;
  }

  return {
    version,
    url,
    sha512: sha512.toLowerCase(),
    executableName: platform === "win32" ? "agy.exe" : "antigravity",
    format: platform === "win32" ? "executable" : "tar.gz",
  };
}

async function detectLinuxMusl(platform: NodeJS.Platform, arch: string): Promise<boolean> {
  if (platform !== "linux") return false;
  const loader = arch === "arm64"
    ? "/lib/libc.musl-aarch64.so.1"
    : "/lib/libc.musl-x86_64.so.1";
  try {
    await access(loader);
    return true;
  } catch {
    return false;
  }
}

async function readBoundedManifestText(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error("Antigravity CLI release manifest exceeded size limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Antigravity CLI release manifest exceeded size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function createTimeoutError(): Error {
  const error = new Error("Antigravity CLI release manifest request timed out.");
  error.name = "AbortError";
  return error;
}

export async function fetchLatestAntigravityRelease(
  options: FetchLatestAntigravityReleaseOptions = {},
): Promise<AntigravityCliReleaseAsset> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const musl = options.musl ?? await detectLinuxMusl(platform, arch);
  const manifestUrl = antigravityManifestUrl(platform, arch, musl);
  if (!manifestUrl) {
    throw new Error("Antigravity CLI release manifest is not available for this platform.");
  }

  options.signal?.throwIfAborted();
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = Math.max(
    250,
    Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  );
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(createTimeoutError());
  }, timeoutMs);
  timer.unref();
  const combinedSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  try {
    const response = await fetchImpl(manifestUrl, {
      signal: combinedSignal,
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error("Antigravity CLI release manifest could not be retrieved.");
    }
    const text = await readBoundedManifestText(response, MAX_MANIFEST_BYTES, combinedSignal);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      throw new Error("Antigravity CLI release manifest could not be verified.");
    }
    const release = parseAntigravityCliRelease(parsedJson, platform, arch, musl);
    if (!release) {
      throw new Error("Antigravity CLI release manifest could not be verified.");
    }
    return release;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timedOut) throw createTimeoutError();
    if (error instanceof Error && error.message.startsWith("Antigravity CLI release manifest")) {
      throw error;
    }
    throw new Error("Antigravity CLI release manifest could not be retrieved.");
  } finally {
    clearTimeout(timer);
  }
}
