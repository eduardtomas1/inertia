import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import type { CanaryRollbackStatus } from "../shared/desktop.js";
import {
  releaseArtifactName,
  type InertiaReleaseChannel,
} from "./release-channel.js";
import {
  readSecureAtomicState,
  writeSecureAtomicState,
} from "./secure-atomic-state.js";

const MAX_STATE_BYTES = 8 * 1_024;
const MAX_CHECKSUM_BYTES = 256 * 1_024;
const MAX_PACKAGE_BYTES = 2 * 1_024 * 1_024 * 1_024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1_000;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

interface RetainedPackage {
  version: string;
  name: string;
  size: number;
  sha256: string;
  preparedAt: string;
}

export interface CanaryRollbackManagerOptions {
  channel: InertiaReleaseChannel;
  version: string;
  platform: NodeJS.Platform;
  architecture: string;
  userDataDirectory: string;
  fetch: typeof globalThis.fetch;
  openPath(path: string): Promise<string>;
  revealPath(path: string): void;
  activeAppImagePath?: string;
  now?: () => Date;
  timeoutMs?: number;
}

interface ChunkWriter {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesWritten: number }>;
}

export async function writeBufferCompletely(
  writer: ChunkWriter,
  buffer: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const remaining = buffer.byteLength - offset;
    const { bytesWritten } = await writer.write(
      buffer,
      offset,
      remaining,
      null,
    );
    if (
      !Number.isSafeInteger(bytesWritten)
      || bytesWritten <= 0
      || bytesWritten > remaining
    ) throw new Error("Rollback package write did not make safe progress.");
    offset += bytesWritten;
  }
}

function status(
  state: CanaryRollbackStatus["state"],
  message: string,
  version: string | null = null,
): CanaryRollbackStatus {
  return { state, version, message };
}

function parseState(value: string | null): RetainedPackage | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RetainedPackage>;
    if (
      Object.keys(parsed).sort().join("\0")
        !== ["name", "preparedAt", "sha256", "size", "version"].join("\0")
      || typeof parsed.version !== "string"
      || !VERSION_PATTERN.test(parsed.version)
      || typeof parsed.name !== "string"
      || basename(parsed.name) !== parsed.name
      || !/^[A-Za-z0-9._-]{1,180}$/u.test(parsed.name)
      || !Number.isSafeInteger(parsed.size)
      || (parsed.size ?? 0) <= 0
      || (parsed.size ?? 0) > MAX_PACKAGE_BYTES
      || typeof parsed.sha256 !== "string"
      || !DIGEST_PATTERN.test(parsed.sha256)
      || typeof parsed.preparedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.preparedAt))
    ) return null;
    return parsed as RetainedPackage;
  } catch {
    return null;
  }
}

async function sha256File(path: string, expectedSize: number): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    return null;
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size !== expectedSize
  ) return null;
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > MAX_PACKAGE_BYTES) return null;
    digest.update(chunk);
  }
  return bytes === expectedSize ? digest.digest("hex") : null;
}

async function boundedText(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error("Rollback checksum unavailable.");
  const declaredHeader = response.headers.get("content-length");
  const declared = Number(declaredHeader);
  if (
    declaredHeader !== null
    && (!Number.isFinite(declared) || declared < 0 || declared > MAX_CHECKSUM_BYTES)
  ) {
    throw new Error("Rollback checksum is oversized.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_CHECKSUM_BYTES) {
        await reader.cancel();
        throw new Error("Rollback checksum is oversized.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const value = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf8", { fatal: true }).decode(value);
}

function expectedDigest(source: string, name: string): string {
  const matches = source.split(/\r?\n/u).flatMap((line) => {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]{1,180})$/u.exec(line);
    return match?.[2] === name ? [match[1]!] : [];
  });
  if (matches.length !== 1) throw new Error("Rollback checksum entry is missing or ambiguous.");
  return matches[0]!;
}

export class CanaryRollbackManager {
  readonly #directory: string;
  readonly #statePath: string;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  #preparation: Promise<CanaryRollbackStatus> | null = null;

  constructor(readonly options: CanaryRollbackManagerOptions) {
    this.#directory = join(options.userDataDirectory, "canary-rollback");
    this.#statePath = join(this.#directory, "last-known-good.json");
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = Math.max(
      1,
      Math.min(options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS, 60 * 60 * 1_000),
    );
  }

  async current(): Promise<CanaryRollbackStatus> {
    if (this.options.channel !== "canary") {
      return status("unavailable", "Rollback packages are available only in Inertia Canary.");
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const retained = parseState(readSecureAtomicState(this.#statePath, MAX_STATE_BYTES));
    if (!retained) {
      return status("not-prepared", "No last-known-good Canary package is retained yet.");
    }
    const digest = await sha256File(join(this.#directory, retained.name), retained.size);
    if (digest !== retained.sha256) {
      return status("failed", "The retained Canary rollback package failed verification.");
    }
    return status(
      "ready",
      `Verified Canary ${retained.version} is retained for rollback.`,
      retained.version,
    );
  }

  prepare(): Promise<CanaryRollbackStatus> {
    if (this.#preparation) return this.#preparation;
    const operation = this.#prepare().finally(() => {
      if (this.#preparation === operation) this.#preparation = null;
    });
    this.#preparation = operation;
    return operation;
  }

  async open(): Promise<CanaryRollbackStatus> {
    const current = await this.current();
    if (current.state !== "ready") return current;
    const retained = parseState(readSecureAtomicState(this.#statePath, MAX_STATE_BYTES));
    if (!retained) return status("failed", "The retained Canary rollback package is invalid.");
    const packagePath = join(this.#directory, retained.name);
    if (await sha256File(packagePath, retained.size) !== retained.sha256) {
      return status("failed", "The retained Canary rollback package failed verification.");
    }
    if (this.options.platform === "linux") {
      const activeAppImagePath = await this.#activeAppImagePath();
      if (!activeAppImagePath) {
        return status(
          "failed",
          "The active Canary AppImage path could not be verified; no rollback file was opened.",
          retained.version,
        );
      }
      try {
        this.options.revealPath(packagePath);
      } catch {
        return status(
          "failed",
          "The operating system could not reveal the verified rollback AppImage.",
          retained.version,
        );
      }
      return status(
        "ready",
        `Revealed the verified Canary ${retained.version} AppImage. Quit Canary, replace the active AppImage at ${activeAppImagePath} with the revealed file, keep that destination executable, then reopen Canary.`,
        retained.version,
      );
    }
    const error = await this.options.openPath(packagePath);
    return error
      ? status("failed", "The operating system could not open the verified rollback package.", retained.version)
      : status("ready", `Opened the verified Canary ${retained.version} rollback package.`, retained.version);
  }

  async #activeAppImagePath(): Promise<string | null> {
    const path = this.options.activeAppImagePath;
    if (!path || !isAbsolute(path)) return null;
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
      return await realpath(path);
    } catch {
      return null;
    }
  }

  async #fetchWithinTimeout<T>(
    url: string,
    timeoutMessage: string,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.options.fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
      return await consume(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(timeoutMessage, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #prepare(): Promise<CanaryRollbackStatus> {
    if (this.options.channel !== "canary") return await this.current();
    if (
      !VERSION_PATTERN.test(this.options.version)
      || !["darwin", "win32", "linux"].includes(this.options.platform)
      || !["arm64", "x64"].includes(this.options.architecture)
    ) return status("failed", "This Canary build cannot prepare a rollback package.");
    const current = await this.current();
    if (current.state === "ready" && current.version === this.options.version) return current;

    const platform = this.options.platform as "darwin" | "win32" | "linux";
    const architecture = this.options.architecture as "arm64" | "x64";
    const name = releaseArtifactName("canary", platform, this.options.version, architecture);
    const baseUrl = `https://github.com/eduardtomas1/inertia/releases/download/canary-v${this.options.version}`;
    const checksum = await this.#fetchWithinTimeout(
      `${baseUrl}/SHA256SUMS.txt`,
      "Rollback checksum download timed out.",
      boundedText,
    );
    const expected = expectedDigest(checksum, name);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(this.#directory, `.${randomUUID()}.download`);
    const downloaded = await this.#fetchWithinTimeout(
      `${baseUrl}/${name}`,
      "Rollback package download timed out.",
      async (response) => {
        if (!response.ok || !response.body) throw new Error("Rollback package unavailable.");
        const declaredHeader = response.headers.get("content-length");
        const declared = Number(declaredHeader);
        if (
          declaredHeader !== null
          && (!Number.isFinite(declared) || declared <= 0 || declared > MAX_PACKAGE_BYTES)
        ) {
          throw new Error("Rollback package has an invalid size.");
        }
        const handle = await open(temporaryPath, "wx", 0o600);
        const digest = createHash("sha256");
        const reader = response.body.getReader();
        let size = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_PACKAGE_BYTES) {
              await reader.cancel();
              throw new Error("Rollback package is oversized.");
            }
            digest.update(next.value);
            await writeBufferCompletely(handle, next.value);
          }
          await handle.sync();
        } catch (error) {
          await handle.close();
          await rm(temporaryPath, { force: true });
          throw error;
        } finally {
          reader.releaseLock();
        }
        await handle.close();
        const actual = digest.digest("hex");
        if (
          size <= 0
          || actual !== expected
          || await sha256File(temporaryPath, size) !== expected
        ) {
          await rm(temporaryPath, { force: true });
          throw new Error("Rollback package digest did not match the release checksum.");
        }
        return { size, actual };
      },
    );
    const { size, actual } = downloaded;
    if (platform === "linux") await chmod(temporaryPath, 0o700);
    const destination = join(this.#directory, name);
    try {
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error("The rollback package destination is unsafe.");
      }
      await rm(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    }
    try {
      await rename(temporaryPath, destination);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    const retained: RetainedPackage = {
      version: this.options.version,
      name,
      size,
      sha256: actual,
      preparedAt: this.#now().toISOString(),
    };
    const previous = parseState(readSecureAtomicState(this.#statePath, MAX_STATE_BYTES));
    writeSecureAtomicState(
      this.#statePath,
      `${JSON.stringify(retained)}\n`,
      MAX_STATE_BYTES,
    );
    if (previous && previous.name !== name) {
      await rm(join(this.#directory, previous.name), { force: true });
    }
    return await this.current();
  }
}
