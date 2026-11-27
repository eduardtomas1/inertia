import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join, sep } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import { credentialFreeProviderEnvironment } from "../environment";
import {
  isProcessTreeTerminationUnconfirmed,
  requireProcessTreeTermination,
  terminateProcessTreeAndWait,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import {
  fetchLatestAntigravityRelease,
  parseAntigravityCliRelease,
  type AntigravityCliReleaseAsset,
} from "./antigravity-cli-release";
import {
  PROVIDER_VERSION_FLOORS,
  providerVersionBelowFloor,
} from "./provider-version-floors";

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_TIMEOUT_MS = 600_000;
const RECORD_MAX_BYTES = 8 * 1024;
const RELEASE_RECORD = ".install-complete.json";
const ACTIVE_RECORD = "active.json";
const RELEASE_ID_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const TAR_LIST_MAX_BYTES = 64 * 1024;
const VALIDATION_OUTPUT_MAX_BYTES = 64 * 1024;
const VALIDATION_TIMEOUT_MS = 15_000;
const TAR_TIMEOUT_MS = 60_000;

export interface ManagedAntigravityExecutable {
  readonly executablePath: string;
  readonly version: string;
  readonly releaseId: string;
}

export interface InstallManagedAntigravityOptions {
  dataDirectory: string;
  asset: AntigravityCliReleaseAsset;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  signal?: AbortSignal;
  downloadTimeoutMs?: number;
  terminateProcessTree?: ProcessTreeTerminator;
  validateExecutable?: (executablePath: string, expectedVersion: string) => Promise<void>;
}

export interface ManagedAntigravityUpdateProgress {
  output: string | null;
  outputTruncated: boolean;
}

export interface ManagedAntigravityUpdateResult
  extends ManagedAntigravityUpdateProgress {
  status: "succeeded" | "failed" | "cancelled" | "timed-out";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  message: string;
  cleanupConfirmed: boolean;
}

export interface ManagedAntigravityUpdateOptions {
  dataDirectory: string;
  expectedExecutable: string;
  beforeVersion?: string | null;
  minimumVersion?: string | null;
  signal: AbortSignal;
  onProgress?: (progress: ManagedAntigravityUpdateProgress) => void;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  downloadTimeoutMs?: number;
  terminateProcessTree?: ProcessTreeTerminator;
  validateExecutable?: (executablePath: string, expectedVersion: string) => Promise<void>;
}

interface ActiveReleaseRecord {
  releaseId: string;
}

interface InstalledReleaseRecord {
  releaseId: string;
  version: string;
  executable: {
    name: string;
    bytes: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "agy.exe" : "antigravity";
}

export function managedAntigravityDirectory(
  dataDirectory: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return join(dataDirectory, "tools", "antigravity", `${platform}-${arch}`);
}

async function isSymlink(targetPath: string): Promise<boolean> {
  try {
    return (await lstat(targetPath)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function isContainedPath(targetPath: string, rootDirectory: string): Promise<boolean> {
  try {
    const [realRoot, realTarget] = await Promise.all([
      realpath(rootDirectory),
      realpath(targetPath),
    ]);
    return realTarget === realRoot || realTarget.startsWith(`${realRoot}${sep}`);
  } catch {
    return false;
  }
}

async function readBoundedJsonFile(filePath: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    if (await isSymlink(filePath)) return null;
    const flags = fsConstants.O_RDONLY
      | (process.platform === "win32" ? 0 : FILE_OPEN_NO_FOLLOW);
    handle = await open(filePath, flags);
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > RECORD_MAX_BYTES) return null;
    const buffer = Buffer.alloc(RECORD_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0 || bytesRead > RECORD_MAX_BYTES) return null;
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function parseActiveRecord(value: unknown): ActiveReleaseRecord | null {
  if (!isRecord(value) || typeof value.releaseId !== "string") return null;
  if (!RELEASE_ID_PATTERN.test(value.releaseId)) return null;
  return { releaseId: value.releaseId };
}

function parseInstalledRecord(
  value: unknown,
  expectedReleaseId: string,
  platform: NodeJS.Platform,
): InstalledReleaseRecord | null {
  if (!isRecord(value)) return null;
  if (value.releaseId !== expectedReleaseId) return null;
  if (typeof value.version !== "string" || !VERSION_PATTERN.test(value.version)) return null;
  if (!isRecord(value.executable)) return null;
  const { name, bytes } = value.executable;
  if (
    typeof name !== "string"
    || name !== expectedExecutableName(platform)
    || name.includes("/")
    || name.includes("\\")
    || name.includes("..")
  ) {
    return null;
  }
  if (
    typeof bytes !== "number"
    || !Number.isSafeInteger(bytes)
    || bytes <= 0
    || bytes > MAX_EXECUTABLE_BYTES
  ) {
    return null;
  }
  return {
    releaseId: expectedReleaseId,
    version: value.version,
    executable: { name, bytes },
  };
}

function managedAntigravityAncestorPaths(
  dataDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const toolsDir = join(dataDirectory, "tools");
  const antigravityDir = join(toolsDir, "antigravity");
  const targetDir = join(antigravityDir, `${platform}-${arch}`);
  const versionsDir = join(targetDir, "versions");
  return [toolsDir, antigravityDir, targetDir, versionsDir];
}

async function hasAncestorSymlink(
  dataDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<boolean> {
  if (await isSymlink(dataDirectory)) return true;
  for (const segment of managedAntigravityAncestorPaths(dataDirectory, platform, arch)) {
    if (await isSymlink(segment)) return true;
  }
  return false;
}

export async function resolveManagedAntigravityExecutable(
  dataDirectory: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<ManagedAntigravityExecutable | null> {
  const managedDir = managedAntigravityDirectory(dataDirectory, platform, arch);
  const versionsDir = join(managedDir, "versions");
  const activePath = join(managedDir, ACTIVE_RECORD);

  if (
    await hasAncestorSymlink(dataDirectory, platform, arch)
    || await isSymlink(activePath)
  ) {
    return null;
  }
  if (!await isContainedPath(managedDir, dataDirectory)) return null;
  if (!await isContainedPath(versionsDir, dataDirectory)) return null;
  if (!await isContainedPath(activePath, dataDirectory)) return null;

  const active = parseActiveRecord(await readBoundedJsonFile(activePath));
  if (!active) return null;

  const releaseDir = join(versionsDir, active.releaseId);
  if (
    await isSymlink(releaseDir)
    || !await isContainedPath(releaseDir, versionsDir)
    || !await isContainedPath(releaseDir, dataDirectory)
  ) {
    return null;
  }
  let releaseDirInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    releaseDirInfo = await lstat(releaseDir);
  } catch {
    return null;
  }
  if (!releaseDirInfo.isDirectory()) return null;

  const recordPath = join(releaseDir, RELEASE_RECORD);
  if (
    await isSymlink(recordPath)
    || !await isContainedPath(recordPath, releaseDir)
    || !await isContainedPath(recordPath, dataDirectory)
  ) {
    return null;
  }
  const record = parseInstalledRecord(
    await readBoundedJsonFile(recordPath),
    active.releaseId,
    platform,
  );
  if (!record) return null;

  const executablePath = join(releaseDir, record.executable.name);
  if (
    await isSymlink(executablePath)
    || !await isContainedPath(executablePath, releaseDir)
    || !await isContainedPath(executablePath, dataDirectory)
  ) {
    return null;
  }
  let executableInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    executableInfo = await lstat(executablePath);
  } catch {
    return null;
  }
  if (!executableInfo.isFile()) return null;
  if (executableInfo.size !== record.executable.bytes) return null;
  if (platform !== "win32" && (executableInfo.mode & 0o111) === 0) return null;

  return {
    executablePath,
    version: record.version,
    releaseId: active.releaseId,
  };
}

function validateAssetForTarget(
  asset: AntigravityCliReleaseAsset,
  platform: NodeJS.Platform,
  arch: string,
): AntigravityCliReleaseAsset {
  const parsed = parseAntigravityCliRelease(asset, platform, arch, false)
    ?? (platform === "linux" ? parseAntigravityCliRelease(asset, platform, arch, true) : null);
  if (
    !parsed
    || asset.executableName !== parsed.executableName
    || asset.format !== parsed.format
  ) {
    throw new Error("The Antigravity release asset is invalid for this platform.");
  }
  return parsed;
}

async function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    maxOutputBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
    terminateProcessTree?: ProcessTreeTerminator;
  },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  const terminator = options.terminateProcessTree ?? terminateProcessTreeAndWait;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let overflowed = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const terminateWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void requireProcessTreeTermination(
        terminator,
        child,
        true,
        "Antigravity managed installation command process tree",
      ).then(
        () => reject(error),
        (terminationError) => reject(terminationError),
      );
    };
    const onAbort = (): void => {
      const reason = options.signal?.reason;
      terminateWithError(
        reason instanceof Error ? reason : new Error("Antigravity installation was cancelled."),
      );
    };
    const timer = setTimeout(() => {
      terminateWithError(new Error("Antigravity installation command timed out."));
    }, options.timeoutMs);
    timer.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxOutputBytes) {
        overflowed = true;
        terminateWithError(new Error("Antigravity installation command output exceeded limit."));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > options.maxOutputBytes) {
        overflowed = true;
        terminateWithError(new Error("Antigravity installation command output exceeded limit."));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
      });
    });
  });
}

async function extractVerifiedTarGz(
  archivePath: string,
  executableName: string,
  destinationPath: string,
  signal?: AbortSignal,
  terminateProcessTree: ProcessTreeTerminator = terminateProcessTreeAndWait,
): Promise<void> {
  const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";
  const env = credentialFreeProviderEnvironment(process.env);
  const [listSettled, detailSettled] = await Promise.allSettled([
    runBoundedCommand(tarCommand, ["-tzf", archivePath], {
      env,
      maxOutputBytes: TAR_LIST_MAX_BYTES,
      timeoutMs: TAR_TIMEOUT_MS,
      terminateProcessTree,
      ...(signal ? { signal } : {}),
    }),
    runBoundedCommand(tarCommand, ["-tvzf", archivePath], {
      env,
      maxOutputBytes: TAR_LIST_MAX_BYTES,
      timeoutMs: TAR_TIMEOUT_MS,
      terminateProcessTree,
      ...(signal ? { signal } : {}),
    }),
  ]);
  const rejections = [listSettled, detailSettled]
    .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
    .map(({ reason }) => reason);
  if (rejections.length > 0) {
    const unconfirmed = rejections.find((reason) => isProcessTreeTerminationUnconfirmed(reason));
    throw unconfirmed ?? rejections[0];
  }
  const listResult = (listSettled as PromiseFulfilledResult<{ exitCode: number | null; stdout: string; stderr: string }>).value;
  const detailResult = (detailSettled as PromiseFulfilledResult<{ exitCode: number | null; stdout: string; stderr: string }>).value;
  if (listResult.exitCode !== 0 || detailResult.exitCode !== 0) {
    throw new Error("Could not inspect the Antigravity release archive.");
  }

  const entries = listResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const detailLines = detailResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (
    entries.length !== 1
    || detailLines.length !== 1
    || entries[0] !== executableName
    || entries[0].includes("..")
    || entries[0].startsWith("/")
    || entries[0].includes("\\")
    || !detailLines[0]!.startsWith("-")
  ) {
    throw new Error("The Antigravity archive must contain exactly one regular executable.");
  }

  signal?.throwIfAborted();
  const outputHandle = await open(
    destinationPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o700,
  );
  let extractedBytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(tarCommand, ["-xOzf", archivePath, executableName], {
        env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let writeChain = Promise.resolve();
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void requireProcessTreeTermination(
          terminateProcessTree,
          child,
          true,
          "Antigravity archive extraction process tree",
        ).then(
          () => reject(error),
          (terminationError) => reject(terminationError),
        );
      };
      const onAbort = (): void => {
        const reason = signal?.reason;
        fail(reason instanceof Error ? reason : new Error("Antigravity installation was cancelled."));
      };
      const timer = setTimeout(() => {
        fail(new Error("Extracting the Antigravity archive timed out."));
      }, TAR_TIMEOUT_MS);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        extractedBytes += chunk.byteLength;
        if (extractedBytes > MAX_EXECUTABLE_BYTES) {
          fail(new Error("The Antigravity executable exceeded its size limit."));
          return;
        }
        child.stdout.pause();
        writeChain = writeChain
          .then(async () => {
            if (settled) return;
            await outputHandle.write(chunk);
            if (!settled) child.stdout.resume();
          })
          .catch((error) => {
            fail(error instanceof Error ? error : new Error("Could not write extracted executable."));
          });
      });
      child.stderr.resume();
      child.once("error", (error) => fail(error));
      child.once("close", (code) => {
        void writeChain.then(() => {
          if (settled) return;
          if (code !== 0 || extractedBytes === 0) {
            fail(new Error("Could not extract the Antigravity executable."));
            return;
          }
          settled = true;
          cleanup();
          resolve();
        });
      });
    });
  } finally {
    await outputHandle.close();
  }
}

async function defaultValidateExecutable(
  executablePath: string,
  expectedVersion: string,
  signal?: AbortSignal,
  terminateProcessTree: ProcessTreeTerminator = terminateProcessTreeAndWait,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...credentialFreeProviderEnvironment(process.env),
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  };
  const versionResult = await runBoundedCommand(executablePath, ["--version"], {
    env,
    maxOutputBytes: VALIDATION_OUTPUT_MAX_BYTES,
    timeoutMs: VALIDATION_TIMEOUT_MS,
    terminateProcessTree,
    ...(signal ? { signal } : {}),
  });
  const combinedVersionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
  if (versionResult.exitCode !== 0 || !combinedVersionOutput.includes(expectedVersion)) {
    throw new Error("The downloaded Antigravity executable failed version verification.");
  }

  const acpHelpResult = await runBoundedCommand(executablePath, ["acp", "--help"], {
    env,
    maxOutputBytes: VALIDATION_OUTPUT_MAX_BYTES,
    timeoutMs: VALIDATION_TIMEOUT_MS,
    terminateProcessTree,
    ...(signal ? { signal } : {}),
  });
  const combinedAcpOutput = `${acpHelpResult.stdout}\n${acpHelpResult.stderr}`;
  if (acpHelpResult.exitCode !== 0 || !/(?:agent client protocol|\bacp\b)/iu.test(combinedAcpOutput)) {
    throw new Error("The downloaded Antigravity executable does not advertise ACP support.");
  }
}

async function downloadAndVerifySha512(
  url: string,
  expectedSha512: string,
  destinationPath: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  timeoutMsInput?: number,
): Promise<void> {
  signal?.throwIfAborted();
  const timeoutMs = typeof timeoutMsInput === "number" && Number.isFinite(timeoutMsInput)
    ? Math.max(1, Math.min(Math.floor(timeoutMsInput), MAX_DOWNLOAD_TIMEOUT_MS))
    : DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const downloadSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const abortError = (): Error => {
    if (timeoutSignal.aborted && !signal?.aborted) {
      return new Error("The Antigravity download timed out.");
    }
    const reason = signal?.reason;
    return reason instanceof Error
      ? reason
      : new Error("Antigravity installation was cancelled.");
  };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: downloadSignal,
      redirect: "error",
    });
  } catch (error) {
    if (downloadSignal.aborted) throw abortError();
    throw error;
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Could not download the official Antigravity release.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("The Antigravity download exceeded its allowed size.");
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }
  const hash = createHash("sha512");
  const reader = response.body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  downloadSignal.addEventListener("abort", onAbort, { once: true });
  let downloadedBytes = 0;
  try {
    for (;;) {
      if (downloadSignal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (downloadSignal.aborted) throw abortError();
      if (done) break;
      downloadedBytes += value.byteLength;
      if (downloadedBytes > MAX_DOWNLOAD_BYTES) {
        throw new Error("The Antigravity download exceeded its allowed size.");
      }
      hash.update(value);
      await handle.write(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (downloadSignal.aborted) throw abortError();
    throw error;
  } finally {
    downloadSignal.removeEventListener("abort", onAbort);
    reader.releaseLock();
    await handle.close();
  }

  if (downloadedBytes === 0 || hash.digest("hex") !== expectedSha512) {
    throw new Error("The Antigravity download failed its SHA-512 checksum verification.");
  }
}

async function writeExclusiveJsonFile(filePath: string, payload: unknown): Promise<void> {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(payload), "utf8");
  } finally {
    await handle.close();
  }
}

export async function installManagedAntigravityRelease(
  options: InstallManagedAntigravityOptions,
): Promise<ManagedAntigravityExecutable> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = validateAssetForTarget(options.asset, platform, arch);
  if (providerVersionBelowFloor(asset.version, PROVIDER_VERSION_FLOORS.antigravity.minimumVersion)) {
    throw new Error(
      `Antigravity ${asset.version} is below the required ACP floor ${PROVIDER_VERSION_FLOORS.antigravity.minimumVersion}.`,
    );
  }
  const releaseId = asset.sha512.slice(0, 64);
  const fetchImpl = options.fetch ?? fetch;
  options.signal?.throwIfAborted();

  const managedDir = managedAntigravityDirectory(options.dataDirectory, platform, arch);
  const versionsDir = join(managedDir, "versions");
  const activePath = join(managedDir, ACTIVE_RECORD);

  if (await hasAncestorSymlink(options.dataDirectory, platform, arch)) {
    throw new Error("The managed Antigravity directory is a symbolic link.");
  }
  await mkdir(versionsDir, { recursive: true });
  if (
    await hasAncestorSymlink(options.dataDirectory, platform, arch)
    || !await isContainedPath(managedDir, options.dataDirectory)
    || !await isContainedPath(versionsDir, options.dataDirectory)
    || !await isContainedPath(versionsDir, managedDir)
  ) {
    throw new Error("The managed Antigravity directory is a symbolic link.");
  }

  const stagingDir = await mkdtemp(join(versionsDir, ".install-"));
  let tempPointerPath: string | null = null;
  try {
    const archivePath = join(stagingDir, "download");
    const runtimeDir = join(stagingDir, "runtime");
    await mkdir(runtimeDir, { mode: 0o700 });

    await downloadAndVerifySha512(
      asset.url,
      asset.sha512,
      archivePath,
      fetchImpl,
      options.signal,
      options.downloadTimeoutMs,
    );

    const stagedExecutable = join(runtimeDir, asset.executableName);
    if (asset.format === "executable") {
      await copyFile(archivePath, stagedExecutable, fsConstants.COPYFILE_EXCL);
      const copiedInfo = await stat(stagedExecutable);
      if (copiedInfo.size <= 0 || copiedInfo.size > MAX_EXECUTABLE_BYTES) {
        throw new Error("The Antigravity executable exceeded its size limit.");
      }
    } else {
      await extractVerifiedTarGz(
        archivePath,
        asset.executableName,
        stagedExecutable,
        options.signal,
        options.terminateProcessTree,
      );
    }
    await unlink(archivePath).catch(() => undefined);

    if (platform !== "win32") {
      await chmod(stagedExecutable, 0o755);
    }

    if (options.validateExecutable) {
      await options.validateExecutable(stagedExecutable, asset.version);
    } else {
      await defaultValidateExecutable(
        stagedExecutable,
        asset.version,
        options.signal,
        options.terminateProcessTree,
      );
    }

    const executableInfo = await stat(stagedExecutable);
    if (
      !executableInfo.isFile()
      || executableInfo.size <= 0
      || executableInfo.size > MAX_EXECUTABLE_BYTES
    ) {
      throw new Error("The staged Antigravity executable is invalid.");
    }

    const record: InstalledReleaseRecord = {
      releaseId,
      version: asset.version,
      executable: {
        name: asset.executableName,
        bytes: executableInfo.size,
      },
    };
    await writeExclusiveJsonFile(join(runtimeDir, RELEASE_RECORD), record);

    const destinationDir = join(versionsDir, releaseId);
    if (
      await hasAncestorSymlink(options.dataDirectory, platform, arch)
      || !await isContainedPath(versionsDir, options.dataDirectory)
    ) {
      throw new Error("The managed Antigravity directory is a symbolic link.");
    }

    let destinationExists = false;
    try {
      await lstat(destinationDir);
      destinationExists = true;
    } catch {
      destinationExists = false;
    }

    if (destinationExists) {
      const displacedDir = join(stagingDir, "displaced");
      await rename(destinationDir, displacedDir);
      try {
        await rename(runtimeDir, destinationDir);
      } catch (error) {
        await rename(displacedDir, destinationDir).catch(() => undefined);
        throw error;
      }
    } else {
      await rename(runtimeDir, destinationDir);
    }

    tempPointerPath = join(managedDir, `.active.${randomUUID()}.tmp`);
    await writeExclusiveJsonFile(tempPointerPath, { releaseId } satisfies ActiveReleaseRecord);
    await rename(tempPointerPath, activePath);
    tempPointerPath = null;

    const resolved = await resolveManagedAntigravityExecutable(
      options.dataDirectory,
      platform,
      arch,
    );
    if (!resolved || resolved.releaseId !== releaseId || resolved.version !== asset.version) {
      throw new Error("The activated Antigravity runtime could not be verified.");
    }
    return resolved;
  } finally {
    if (tempPointerPath) {
      await unlink(tempPointerPath).catch(() => undefined);
    }
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sameCanonicalPath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") return left === right;
  return left.replaceAll("\\", "/").toLocaleLowerCase("en-US")
    === right.replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

export async function runManagedAntigravityUpdate(
  options: ManagedAntigravityUpdateOptions,
): Promise<ManagedAntigravityUpdateResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  try {
    options.signal.throwIfAborted();
    const active = await resolveManagedAntigravityExecutable(
      options.dataDirectory,
      platform,
      arch,
    );
    if (!active) {
      return {
        status: "failed",
        exitCode: null,
        signal: null,
        message: "The active managed Antigravity runtime could not be verified in this data directory.",
        output: null,
        outputTruncated: false,
        cleanupConfirmed: true,
      };
    }
    const [activeReal, expectedReal] = await Promise.all([
      realpath(active.executablePath).catch(() => active.executablePath),
      realpath(options.expectedExecutable).catch(() => options.expectedExecutable),
    ]);
    if (!sameCanonicalPath(activeReal, expectedReal, platform)) {
      return {
        status: "failed",
        exitCode: null,
        signal: null,
        message: "The targeted Antigravity executable does not match the active managed runtime for this data directory.",
        output: null,
        outputTruncated: false,
        cleanupConfirmed: true,
      };
    }
    options.onProgress?.({
      output: "Checking official Antigravity release manifest...",
      outputTruncated: false,
    });
    const asset = await fetchLatestAntigravityRelease({
      signal: options.signal,
      platform,
      arch,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if (providerVersionBelowFloor(asset.version, PROVIDER_VERSION_FLOORS.antigravity.minimumVersion)) {
      return {
        status: "failed",
        exitCode: null,
        signal: null,
        message: `Antigravity ${asset.version} is below the required ACP floor ${PROVIDER_VERSION_FLOORS.antigravity.minimumVersion}.`,
        output: null,
        outputTruncated: false,
        cleanupConfirmed: true,
      };
    }
    if (providerVersionBelowFloor(asset.version, active.version)) {
      return {
        status: "failed",
        exitCode: null,
        signal: null,
        message: `Refused to downgrade Antigravity from ${active.version} to ${asset.version}.`,
        output: null,
        outputTruncated: false,
        cleanupConfirmed: true,
      };
    }
    if (options.beforeVersion && providerVersionBelowFloor(asset.version, options.beforeVersion)) {
      return {
        status: "failed",
        exitCode: null,
        signal: null,
        message: `Refused to downgrade Antigravity from ${options.beforeVersion} to ${asset.version}.`,
        output: null,
        outputTruncated: false,
        cleanupConfirmed: true,
      };
    }
    if (options.minimumVersion && providerVersionBelowFloor(asset.version, options.minimumVersion)) {
      return {
        status: "failed",
        exitCode: null,
        signal: null,
        message: `Antigravity manifest returned ${asset.version}, older than approved release ${options.minimumVersion}.`,
        output: null,
        outputTruncated: false,
        cleanupConfirmed: true,
      };
    }
    options.onProgress?.({
      output: `Downloading and verifying Antigravity ${asset.version}...`,
      outputTruncated: false,
    });
    const installed = await installManagedAntigravityRelease({
      dataDirectory: options.dataDirectory,
      asset,
      signal: options.signal,
      platform,
      arch,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.downloadTimeoutMs !== undefined
        ? { downloadTimeoutMs: options.downloadTimeoutMs }
        : {}),
      ...(options.terminateProcessTree
        ? { terminateProcessTree: options.terminateProcessTree }
        : {}),
      ...(options.validateExecutable
        ? { validateExecutable: options.validateExecutable }
        : {}),
    });
    return {
      status: "succeeded",
      exitCode: 0,
      signal: null,
      message: `Updated managed Antigravity runtime to ${installed.version}.`,
      output: `Installed verified Antigravity ${installed.version}.`,
      outputTruncated: false,
      cleanupConfirmed: true,
    };
  } catch (error) {
    const cleanupConfirmed = !isProcessTreeTerminationUnconfirmed(error);
    if (options.signal.aborted && cleanupConfirmed) {
      return {
        status: "cancelled",
        exitCode: null,
        signal: null,
        message: "Provider update cancelled.",
        output: null,
        outputTruncated: false,
        cleanupConfirmed: true,
      };
    }
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "Could not update the managed Antigravity runtime.";
    return {
      status: "failed",
      exitCode: null,
      signal: null,
      message,
      output: message,
      outputTruncated: false,
      cleanupConfirmed,
    };
  }
}
