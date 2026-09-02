import { createHash, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isUtf8 } from "node:buffer";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";

import type { WindowsRuntimeJobContainment } from "../node/runtime-owned-processes.js";
import { validRuntimeGenerationId } from "../node/runtime-process-protocol.js";
import {
  WINDOWS_RUNTIME_JOB_BROKER_FORCE_CLOSE_MARGIN_MS,
  WINDOWS_RUNTIME_JOB_BROKER_SHUTDOWN_TIMEOUT_MS,
} from "./privileged-shutdown-deadline.js";
import {
  resolveWindowsRuntimeJobAssemblyPath,
  type RuntimeAssetLocations,
} from "./runtime-assets.js";

declare const __INERTIA_WINDOWS_RUNTIME_JOB_SHA256__: string | null;

// Generated from windows-runtime-job-integrity.json by electron.vite.config.ts.
// The same captured value is emitted as a package-time verification sidecar.
const windowsRuntimeJobIntegrity = Object.freeze({
  sha256: typeof __INERTIA_WINDOWS_RUNTIME_JOB_SHA256__ === "undefined"
    ? null
    : __INERTIA_WINDOWS_RUNTIME_JOB_SHA256__,
});

const NATIVE_READY_TIMEOUT_MS = 15_000;
const EXECUTABLE_LOCKED_MARKER = "LOCKED";
const EXECUTABLE_LOCK_SHUTDOWN = "SHUTDOWN\n";
const EXECUTABLE_LOCK_BYE_MARKER = "BYE";
const MAX_OUTPUT_BYTES = 8_192;
const MAX_BROKER_FIELD_CHARS = 2_048;
const MAX_BROKER_BOOTSTRAP_SCRIPT_BYTES = 64 * 1024;
const MAX_BROKER_BOOTSTRAP_LINE_CHARS =
  Math.ceil(MAX_BROKER_BOOTSTRAP_SCRIPT_BYTES / 3) * 4;
const MAX_PROCESS_METRICS = 1_024;
const PROCESS_METRIC_POLL_MS = 10;
const PROCESS_METRIC_TIMEOUT_MS = 5_000;
const MAX_PROCESS_METRIC_ATTEMPTS = 500;
const MAX_WINDOWS_JOB_ASSEMBLY_BYTES = 1024 * 1024;
const BROKER_HELPER_GRACEFUL_EXIT_MS = 2_000;
const BROKER_HELPER_FORCED_EXIT_MS = 1_000;
// Stop-Helpers can consume both exit budgets before it writes BYE.
const BROKER_SHUTDOWN_ACK_MARGIN_MS = 1_000;
if (
  BROKER_HELPER_GRACEFUL_EXIT_MS
    + BROKER_HELPER_FORCED_EXIT_MS
    + BROKER_SHUTDOWN_ACK_MARGIN_MS
  !== WINDOWS_RUNTIME_JOB_BROKER_SHUTDOWN_TIMEOUT_MS
) {
  throw new Error("The Windows runtime broker shutdown budget is inconsistent.");
}

type WindowsRuntimeJobStage = "native-guard-start";

interface WindowsRuntimeJobExecutableLock {
  isHeld(): boolean;
  request(
    mode: "guard" | "recover",
    arguments_: readonly string[],
    deadlineAt: number,
  ): Promise<WindowsRuntimeJobBrokerResult>;
  release(): Promise<void>;
  abort(): Promise<void>;
}

interface WindowsRuntimeJobBrokerResult {
  readonly status: "READY" | `EXIT:${number}` | "TIMEOUT";
  readonly stdout: string;
  readonly stderr: string;
}

interface PreparedWindowsRuntimeJobExecutableLock {
  readonly assemblyKey: string;
  ready: Promise<void>;
  lock: WindowsRuntimeJobExecutableLock | null;
}

export interface WindowsRuntimeJobAssembly {
  readonly path: string;
  readonly root: string;
  readonly sha256: string;
}

export interface WindowsRuntimeProcessMetric {
  readonly pid: number;
  readonly creationTime: number;
  readonly name?: string;
  readonly type: string;
}

const pendingJobNames = new Set<string>();
let preparedExecutableLock: PreparedWindowsRuntimeJobExecutableLock | null = null;

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return Object.entries(environment).find(([key, value]) =>
    key.toLowerCase() === name.toLowerCase() && typeof value === "string")?.[1];
}

export function windowsRuntimeJobEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | null {
  const root = environmentValue(environment, "SystemRoot")?.trim();
  const temporary = (
    environmentValue(environment, "TEMP")
    ?? environmentValue(environment, "TMP")
  )?.trim();
  if (
    !root
    || !win32.isAbsolute(root)
    || !/^[a-z]:\\/iu.test(root)
    || !temporary
    || !win32.isAbsolute(temporary)
    || !/^[a-z]:\\/iu.test(temporary)
  ) return null;
  const normalizedTemporary = win32.normalize(temporary);
  return {
    ComSpec: win32.join(root, "System32", "cmd.exe"),
    PATH: win32.join(root, "System32"),
    SystemRoot: root,
    SYSTEMROOT: root,
    WINDIR: root,
    TEMP: normalizedTemporary,
    TMP: normalizedTemporary,
  };
}

export function windowsRuntimeJobName(
  runtimeGenerationId: string,
): string {
  if (!validRuntimeGenerationId(runtimeGenerationId)) {
    throw new Error("The runtime generation identity is invalid.");
  }
  const digest = createHash("sha256")
    .update(runtimeGenerationId)
    .digest("hex");
  // Fast user switching and RDP create distinct session namespaces. The
  // global Job Object remains addressable when Inertia restarts in another
  // session; its default ACL still limits access to the creating identity.
  return `Global\\InertiaRuntime-${digest}`;
}

export function windowsRuntimeProcessCreationIdentity(
  metrics: readonly WindowsRuntimeProcessMetric[],
  runtimePid: number,
): string {
  if (!Number.isSafeInteger(runtimePid) || runtimePid <= 1) {
    throw new Error("The Windows runtime process identity is invalid.");
  }
  if (metrics.length > MAX_PROCESS_METRICS) {
    throw new Error("The Windows runtime process metrics are oversized.");
  }
  const matching = metrics.filter((metric) =>
    metric.pid === runtimePid
    && metric.type === "Utility"
    && metric.name === "Inertia Runtime");
  if (matching.length !== 1) {
    throw new Error("The Windows runtime process metric is not unique.");
  }
  const metric = matching[0]!;
  if (
    !Number.isFinite(metric.creationTime)
    || metric.creationTime <= 0
  ) {
    throw new Error("The Windows runtime creation identity is invalid.");
  }
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeDoubleLE(metric.creationTime);
  return encoded.readBigUInt64LE().toString(10);
}

export async function waitForWindowsRuntimeProcessCreationIdentity(
  getMetrics: () => readonly WindowsRuntimeProcessMetric[],
  runtimePid: number,
  options: {
    readonly timeoutMs?: number;
    readonly now?: () => number;
    readonly shouldContinue?: () => boolean;
    readonly yieldTurn?: () => Promise<void>;
  } = {},
): Promise<string> {
  const timeoutMs = Math.max(1, Math.min(
    options.timeoutMs ?? PROCESS_METRIC_TIMEOUT_MS,
    PROCESS_METRIC_TIMEOUT_MS,
  ));
  const now = options.now ?? Date.now;
  const deadlineAt = now() + timeoutMs;
  const yieldTurn = options.yieldTurn ?? (() => new Promise<void>((resolve) => {
    setTimeout(resolve, PROCESS_METRIC_POLL_MS);
  }));
  for (let attempt = 0; attempt < MAX_PROCESS_METRIC_ATTEMPTS; attempt += 1) {
    if (options.shouldContinue?.() === false) {
      throw new Error("The Windows runtime process admission is no longer current.");
    }
    if (now() >= deadlineAt) break;
    // Electron publishes a freshly spawned UtilityProcess into app metrics on
    // a later task. Always yield before the first bounded observation.
    await yieldTurn();
    if (options.shouldContinue?.() === false) {
      throw new Error("The Windows runtime process admission is no longer current.");
    }
    const metrics = getMetrics();
    if (metrics.length > MAX_PROCESS_METRICS) {
      throw new Error("The Windows runtime process metrics are oversized.");
    }
    const candidates = metrics.filter((metric) =>
      metric.pid === runtimePid
      && metric.type === "Utility"
      && metric.name === "Inertia Runtime");
    if (candidates.length === 0) continue;
    return windowsRuntimeProcessCreationIdentity(candidates, runtimePid);
  }
  throw new Error("The Windows runtime process metric is unavailable.");
}


function normalizedWindowsRuntimeJobAssembly(
  assembly: WindowsRuntimeJobAssembly,
): WindowsRuntimeJobAssembly {
  const root = resolve(assembly.root);
  const path = resolve(assembly.path);
  if (
    path !== join(root, "windows-runtime-job.exe")
    || !/^[0-9a-f]{64}$/u.test(assembly.sha256)
  ) {
    throw new Error("The Windows runtime Job Object assembly authority is invalid.");
  }
  return { path, root, sha256: assembly.sha256 };
}

function assertDirectAssetBoundary(root: string, path: string): void {
  for (const current of [root, path]) {
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (!metadata || metadata.isSymbolicLink()) {
      throw new Error(`The Windows runtime Job Object assembly path is not direct: ${path}`);
    }
  }
}

export function validateWindowsRuntimeJobAssembly(
  candidate: WindowsRuntimeJobAssembly,
): WindowsRuntimeJobAssembly {
  const assembly = normalizedWindowsRuntimeJobAssembly(candidate);
  assertDirectAssetBoundary(assembly.root, assembly.path);
  const canonicalRoot = realpathSync.native(assembly.root);
  const canonicalPath = realpathSync.native(assembly.path);
  if (canonicalPath !== join(canonicalRoot, "windows-runtime-job.exe")) {
    throw new Error("The Windows runtime Job Object assembly escaped its asset root.");
  }
  const descriptor = lstatSync(assembly.path, { throwIfNoEntry: false });
  if (
    !descriptor
    || !descriptor.isFile()
    || descriptor.size <= 0
    || descriptor.size > MAX_WINDOWS_JOB_ASSEMBLY_BYTES
  ) {
    throw new Error(`The Windows runtime Job Object assembly is missing or invalid: ${assembly.path}`);
  }
  const handle = openSync(assembly.path, constants.O_RDONLY);
  let bytes: Buffer;
  try {
    const before = fstatSync(handle, { bigint: true });
    if (
      !before.isFile()
      || before.size <= 0n
      || before.size > BigInt(MAX_WINDOWS_JOB_ASSEMBLY_BYTES)
    ) {
      throw new Error("The Windows runtime Job Object assembly changed during validation.");
    }
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fstatSync(handle, { bigint: true });
    if (
      offset !== bytes.length
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
    ) {
      throw new Error("The Windows runtime Job Object assembly changed during validation.");
    }
  } finally {
    closeSync(handle);
  }
  const actual = createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(assembly.sha256, "hex");
  if (!timingSafeEqual(actual, expected)) {
    throw new Error("The Windows runtime Job Object assembly integrity check failed.");
  }
  return {
    path: canonicalPath,
    root: canonicalRoot,
    sha256: assembly.sha256,
  };
}

export function resolveRequiredWindowsRuntimeJobAssembly(options: {
  readonly platform: NodeJS.Platform;
  readonly locations: RuntimeAssetLocations;
  readonly expectedSha256?: string | null;
}): WindowsRuntimeJobAssembly | null {
  if (options.platform !== "win32") return null;
  const path = resolveWindowsRuntimeJobAssemblyPath(options.locations);
  const root = dirname(path);
  const sha256 = options.expectedSha256 ?? windowsRuntimeJobIntegrity.sha256;
  if (typeof sha256 !== "string") {
    throw new Error("The Windows runtime Job Object integrity manifest is unavailable.");
  }
  return validateWindowsRuntimeJobAssembly({ path, root, sha256 });
}

function selectedWindowsRuntimeJobAssembly(options: {
  readonly assembly?: WindowsRuntimeJobAssembly;
}): WindowsRuntimeJobAssembly {
  if (!options.assembly) {
    throw new Error("The Windows runtime Job Object assembly authority is unavailable.");
  }
  return validateWindowsRuntimeJobAssembly(options.assembly);
}

function windowsRuntimeJobAssemblyKey(
  assembly: WindowsRuntimeJobAssembly,
): string {
  return `${assembly.root}\0${assembly.path}\0${assembly.sha256}`;
}

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
}

function decodeBrokerField(value: string): string {
  if (
    value.length > MAX_OUTPUT_BYTES * 2
    || value.length % 4 !== 0
    || !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/u
      .test(value)
  ) {
    throw new Error("The Windows runtime broker returned an invalid result.");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length > MAX_OUTPUT_BYTES
    || bytes.toString("base64") !== value
    || !isUtf8(bytes)
  ) {
    throw new Error("The Windows runtime broker returned an invalid result.");
  }
  return bytes.toString("utf8");
}

function latestHelperStage(output: string): WindowsRuntimeJobStage | null {
  const matches = output.matchAll(
    /INERTIA_JOB_STAGE stage=(native-guard-start)/gu,
  );
  let latest: WindowsRuntimeJobStage | null = null;
  for (const match of matches) latest = match[1] as WindowsRuntimeJobStage;
  return latest;
}

function encodedPowerShell(value: string): string {
  return Buffer.from(value, "utf16le").toString("base64");
}

function windowsRuntimeJobBootstrapScript(): string {
  return `$ErrorActionPreference = 'Stop'
try {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or
    $line.Length -lt 1 -or
    $line.Length -gt ${MAX_BROKER_BOOTSTRAP_LINE_CHARS}) {
    throw 'bootstrap-size'
  }
  $bytes = [Convert]::FromBase64String($line)
  if ($bytes.Length -lt 1 -or
    $bytes.Length -gt ${MAX_BROKER_BOOTSTRAP_SCRIPT_BYTES} -or
    [Convert]::ToBase64String($bytes) -cne $line) {
    throw 'bootstrap-encoding'
  }
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  $script = $utf8.GetString($bytes)
  & ([ScriptBlock]::Create($script))
} catch {
  [Console]::Error.WriteLine('INERTIA_JOB_ERROR stage=broker-bootstrap')
  exit 25
}`;
}

function encodedWindowsRuntimeJobLockScript(
  assembly: WindowsRuntimeJobAssembly,
): string {
  const bytes = Buffer.from(windowsRuntimeJobLockScript(assembly), "utf8");
  if (
    bytes.length < 1
    || bytes.length > MAX_BROKER_BOOTSTRAP_SCRIPT_BYTES
  ) {
    throw new Error("The Windows runtime broker bootstrap is oversized.");
  }
  return bytes.toString("base64");
}

function windowsRuntimeJobLockScript(
  assembly: WindowsRuntimeJobAssembly,
): string {
  const encodedPath = Buffer.from(assembly.path, "utf8").toString("base64");
  const encodedLockedMarker = Buffer.from(
    `${EXECUTABLE_LOCKED_MARKER}\n`,
    "utf8",
  ).toString("base64");
  const encodedFailure = Buffer.from(
    "INERTIA_JOB_ERROR stage=verified-file-lock\n",
    "utf8",
  ).toString("base64");
  return `$ErrorActionPreference = 'Stop'
$stream = $null
function Write-Frame([string] $value) {
  $output = [Console]::OpenStandardOutput()
  $bytes = [Text.Encoding]::UTF8.GetBytes($value + [char]10)
  $output.Write($bytes, 0, $bytes.Length)
  $output.Flush()
}
function Encode-Field([string] $value) {
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))
}
function Write-Result(
  [string] $id,
  [string] $status,
  [string] $stdout,
  [string] $stderr
) {
  if ($stdout.Length -gt ${MAX_BROKER_FIELD_CHARS}) { $stdout = $stdout.Substring(0, ${MAX_BROKER_FIELD_CHARS}) }
  if ($stderr.Length -gt ${MAX_BROKER_FIELD_CHARS}) { $stderr = $stderr.Substring(0, ${MAX_BROKER_FIELD_CHARS}) }
  Write-Frame ('RESULT ' + $id + ' ' + $status + ' ' + (Encode-Field $stdout) + ' ' + (Encode-Field $stderr))
}
try {
  $path = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String('${encodedPath}')
  )
  $stream = [IO.File]::Open(
    $path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  if ($stream.Length -le 0 -or $stream.Length -gt ${MAX_WINDOWS_JOB_ASSEMBLY_BYTES}) {
    throw 'invalid-size'
  }
  $assemblyBytes = [byte[]]::new([Int32]$stream.Length)
  $assemblyOffset = 0
  while ($assemblyOffset -lt $assemblyBytes.Length) {
    $read = $stream.Read(
      $assemblyBytes,
      $assemblyOffset,
      $assemblyBytes.Length - $assemblyOffset
    )
    if ($read -le 0) { throw 'assembly-read' }
    $assemblyOffset += $read
  }
  if ($assemblyOffset -ne $assemblyBytes.Length -or $stream.ReadByte() -ne -1) {
    throw 'assembly-read'
  }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $actual = [BitConverter]::ToString(
      $sha256.ComputeHash($assemblyBytes)
    ).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  if ($actual -cne '${assembly.sha256}') { throw 'integrity-mismatch' }
  $loadedAssembly = [Reflection.Assembly]::Load($assemblyBytes)
  $jobType = $loadedAssembly.GetType('InertiaRuntimeJob', $true, $false)
  $beginGuardMethod = $jobType.GetMethod('BeginGuard')
  $recoverMethod = $jobType.GetMethod('RecoverManaged')
  $shutdownMethod = $jobType.GetMethod('ShutdownAll')
  if ($null -eq $beginGuardMethod -or
    $null -eq $recoverMethod -or
    $null -eq $shutdownMethod) { throw 'assembly-contract' }
  $stdout = [Console]::OpenStandardOutput()
  $locked = [Convert]::FromBase64String('${encodedLockedMarker}')
  $stdout.Write($locked, 0, $locked.Length)
  $stdout.Flush()
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line -ceq '${EXECUTABLE_LOCK_SHUTDOWN.trim()}') {
      $shutdownArguments = [Object[]]@(
        ${BROKER_HELPER_GRACEFUL_EXIT_MS + BROKER_HELPER_FORCED_EXIT_MS},
        $null
      )
      $shutdownCode = [Int32]$shutdownMethod.Invoke($null, $shutdownArguments)
      if ($shutdownCode -ne 0) { throw 'guardian-exit-unconfirmed' }
      Write-Frame '${EXECUTABLE_LOCK_BYE_MARKER}'
      break
    }
    if ($line.Length -gt 2048) { throw 'command-oversized' }
    $parts = $line.Split(' ')
    $mode = $parts[0]
    if ($mode -ceq 'GUARD' -and $parts.Length -eq 6) {
      $id = $parts[1]
      $name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
      $pidValue = $parts[3]
      $creation = $parts[4]
      $timeout = [Int32]::Parse($parts[5], [Globalization.CultureInfo]::InvariantCulture)
      if ($id -notmatch '^[1-9][0-9]{0,9}$' -or
        $name -notmatch '^Global\\\\InertiaRuntime-[0-9a-f]{64}$' -or
        $pidValue -notmatch '^[1-9][0-9]{0,9}$' -or
        $creation -notmatch '^[1-9][0-9]{0,19}$' -or
        $timeout -lt 1 -or $timeout -gt ${NATIVE_READY_TIMEOUT_MS}) { throw 'guard-command' }
      $guardArguments = [Object[]]@(
        $name,
        $pidValue,
        $creation,
        $null
      )
      $guardCode = [Int32]$beginGuardMethod.Invoke($null, $guardArguments)
      $guardDiagnostic = [string]$guardArguments[3]
      if ($guardCode -eq 0) {
        Write-Result $id 'READY' 'READY' ''
      } else {
        Write-Result $id ('EXIT:' + $guardCode) '' $guardDiagnostic
      }
      continue
    }
    if ($mode -ceq 'RECOVER' -and $parts.Length -eq 4) {
      $id = $parts[1]
      $name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
      $timeout = [Int32]::Parse($parts[3], [Globalization.CultureInfo]::InvariantCulture)
      if ($id -notmatch '^[1-9][0-9]{0,9}$' -or
        $name -notmatch '^Global\\\\InertiaRuntime-[0-9a-f]{64}$' -or
        $timeout -lt 1 -or $timeout -gt ${NATIVE_READY_TIMEOUT_MS}) { throw 'recover-command' }
      $recoverCode = [Int32]$recoverMethod.Invoke(
        $null,
        [Object[]]@($name)
      )
      Write-Result $id ('EXIT:' + $recoverCode) '' ''
      continue
    }
    throw 'command-invalid'
  }
  exit 0
} catch {
  $stderr = [Console]::OpenStandardError()
  $failure = [Convert]::FromBase64String('${encodedFailure}')
  $stderr.Write($failure, 0, $failure.Length)
  $stderr.Flush()
  exit 25
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}`;
}

function spawnWindowsRuntimeJobLockBroker(
  assembly: WindowsRuntimeJobAssembly,
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const trustedEnvironment = windowsRuntimeJobEnvironment(environment);
  const systemRoot = trustedEnvironment?.SystemRoot;
  if (!trustedEnvironment || !systemRoot) {
    throw new Error("The trusted Windows runtime environment is unavailable.");
  }
  const bootstrapLine = encodedWindowsRuntimeJobLockScript(assembly);
  const child = spawn(
    win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedPowerShell(windowsRuntimeJobBootstrapScript()),
    ],
    {
      env: trustedEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  // Keep the trusted command line small on Windows ARM64. The complete,
  // internally generated broker remains bounded and crosses the inherited
  // pipe before LOCKED; all later protocol frames use that same pipe.
  child.stdin.on("error", () => undefined);
  child.stdin.write(`${bootstrapLine}\n`);
  return child;
}

async function acquireWindowsRuntimeJobExecutableLock(
  assembly: WindowsRuntimeJobAssembly,
  environment: NodeJS.ProcessEnv,
  deadlineAt: number,
  spawnLockBroker: typeof spawnWindowsRuntimeJobLockBroker,
): Promise<WindowsRuntimeJobExecutableLock> {
  const child = spawnLockBroker(assembly, environment);
  let stdoutBuffer = "";
  const stdoutLines: string[] = [];
  let stderr = "";
  let errored = false;
  let closed = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    if (stdoutBuffer.length > MAX_OUTPUT_BYTES * 2) {
      errored = true;
      child.kill();
      return;
    }
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      stdoutLines.push(stdoutBuffer.slice(0, newline).replace(/\r$/u, ""));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (stdoutLines.length > 64) {
        errored = true;
        child.kill();
        break;
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  // The broker can die between LOCKED and RELEASE. Its pipe failure is already
  // reflected by process liveness; consuming EPIPE keeps cleanup fail closed.
  child.stdin.on("error", () => undefined);
  child.once("error", () => { errored = true; });
  child.once("close", () => { closed = true; });
  const awaitChildClose = async (timeoutMs: number): Promise<boolean> => {
    if (closed) return true;
    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  };
  while (true) {
    const lockedIndex = stdoutLines.indexOf(EXECUTABLE_LOCKED_MARKER);
    const locked = lockedIndex >= 0;
    if (
      locked
      && !errored
      && child.exitCode === null
      && child.signalCode === null
    ) {
      stdoutLines.splice(lockedIndex, 1);
      let held = true;
      let requestCounter = 0;
      let requestTail = Promise.resolve();
      child.once("error", () => { held = false; });
      child.once("exit", () => { held = false; });
      const isHeld = (): boolean => {
        if (!held || child.exitCode !== null || child.signalCode !== null) return false;
        try {
          return child.kill(0);
        } catch {
          return false;
        }
      };
      const requestNow = async (
        mode: "guard" | "recover",
        arguments_: readonly string[],
        operationDeadlineAt: number,
      ): Promise<WindowsRuntimeJobBrokerResult> => {
        if (!isHeld()) {
          throw new Error("The verified Windows runtime executable lock is unavailable.");
        }
        const remainingMs = Math.max(1, Math.min(
          Math.trunc(operationDeadlineAt - Date.now()) - 50,
          NATIVE_READY_TIMEOUT_MS,
        ));
        if (Date.now() >= operationDeadlineAt) {
          throw new Error("The Windows runtime broker operation deadline elapsed.");
        }
        requestCounter += 1;
        const requestId = String(requestCounter);
        const encodedName = Buffer.from(arguments_[0] ?? "", "utf8").toString("base64");
        const command = mode === "guard"
          ? `GUARD ${requestId} ${encodedName} ${arguments_[1]} ${arguments_[2]} ${remainingMs}\n`
          : `RECOVER ${requestId} ${encodedName} ${remainingMs}\n`;
        child.stdin.write(command);
        const prefix = `RESULT ${requestId} `;
        while (Date.now() < operationDeadlineAt) {
          if (!isHeld()) {
            throw new Error("The verified Windows runtime executable lock was lost.");
          }
          const resultIndex = stdoutLines.findIndex((line) => line.startsWith(prefix));
          if (resultIndex >= 0) {
            const [tag, id, status, encodedOutput, encodedError, ...extra] =
              stdoutLines.splice(resultIndex, 1)[0]!.split(" ");
            if (
              tag !== "RESULT"
              || id !== requestId
              || extra.length !== 0
              || !status
              || !/^(?:READY|TIMEOUT|EXIT:[0-9]{1,3})$/u.test(status)
              || encodedOutput === undefined
              || encodedError === undefined
              || encodedOutput.length > MAX_OUTPUT_BYTES * 2
              || encodedError.length > MAX_OUTPUT_BYTES * 2
            ) {
              throw new Error("The Windows runtime broker returned an invalid result.");
            }
            const result = {
              status: status as WindowsRuntimeJobBrokerResult["status"],
              stdout: decodeBrokerField(encodedOutput),
              stderr: decodeBrokerField(encodedError),
            };
            if (!isHeld()) {
              throw new Error("The verified Windows runtime executable lock was lost.");
            }
            return result;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        held = false;
        // A broker request timeout invalidates the whole verified launch
        // authority. Killing the broker closes every retained guardian stdin;
        // each guardian then terminates its own Job through its EOF watcher.
        child.kill();
        throw new Error("The Windows runtime broker operation deadline elapsed.");
      };
      return {
        isHeld,
        request: (mode, arguments_, operationDeadlineAt) => {
          const operation = requestTail.then(() =>
            requestNow(mode, arguments_, operationDeadlineAt));
          requestTail = operation.then(() => undefined, () => undefined);
          return operation;
        },
        release: async () => {
          const requestedShutdown = held;
          held = false;
          if (
            requestedShutdown
            && !child.stdin.destroyed
            && !child.stdin.writableEnded
          ) {
            try {
              child.stdin.end(EXECUTABLE_LOCK_SHUTDOWN);
            } catch {
              if (child.exitCode === null && child.signalCode === null) child.kill();
            }
          } else if (
            requestedShutdown
            && child.exitCode === null
            && child.signalCode === null
          ) {
            child.kill();
          }
          if (!closed) {
            const terminate = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill();
            }, WINDOWS_RUNTIME_JOB_BROKER_SHUTDOWN_TIMEOUT_MS);
            const didClose = await awaitChildClose(
              WINDOWS_RUNTIME_JOB_BROKER_SHUTDOWN_TIMEOUT_MS
                + WINDOWS_RUNTIME_JOB_BROKER_FORCE_CLOSE_MARGIN_MS,
            );
            clearTimeout(terminate);
            if (!didClose) {
              throw new Error(
                "The Windows runtime executable broker did not close during shutdown.",
              );
            }
          }
          if (
            requestedShutdown
            && !stdoutLines.includes(EXECUTABLE_LOCK_BYE_MARKER)
          ) {
            throw new Error("The Windows runtime executable broker did not acknowledge shutdown.");
          }
        },
        abort: async () => {
          held = false;
          if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.destroy();
          if (child.exitCode === null && child.signalCode === null) child.kill();
          if (!await awaitChildClose(1_000)) {
            throw new Error("The Windows runtime executable broker could not be aborted.");
          }
        },
      };
    }
    if (
      errored
      || closed
      || Date.now() >= deadlineAt
    ) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await awaitChildClose(1_000);
  const detail = stderr.trim().replace(/\s+/gu, " ").slice(0, 500);
  throw new Error([
    "The Windows runtime Job Object executable could not be locked and verified.",
    detail,
  ].filter(Boolean).join(" "));
}

export async function prepareWindowsRuntimeJobExecutableLock(
  candidate: WindowsRuntimeJobAssembly,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly spawnLockBroker?: typeof spawnWindowsRuntimeJobLockBroker;
  } = {},
): Promise<void> {
  const assembly = validateWindowsRuntimeJobAssembly(candidate);
  const assemblyKey = windowsRuntimeJobAssemblyKey(assembly);
  const existing = preparedExecutableLock;
  if (existing) {
    if (existing.assemblyKey !== assemblyKey) {
      throw new Error("A different Windows runtime executable lock is already prepared.");
    }
    await existing.ready;
    if (!existing.lock?.isHeld()) {
      throw new Error("The verified Windows runtime executable lock is unavailable.");
    }
    return;
  }
  const timeoutMs = Math.max(1, Math.min(
    options.timeoutMs ?? NATIVE_READY_TIMEOUT_MS,
    NATIVE_READY_TIMEOUT_MS,
  ));
  const state: PreparedWindowsRuntimeJobExecutableLock = {
    assemblyKey,
    lock: null,
    ready: Promise.resolve(),
  };
  state.ready = (async () => {
    const lock = await acquireWindowsRuntimeJobExecutableLock(
      assembly,
      options.environment ?? process.env,
      Date.now() + timeoutMs,
      options.spawnLockBroker ?? spawnWindowsRuntimeJobLockBroker,
    );
    if (preparedExecutableLock !== state) {
      await lock.abort();
      throw new Error("The Windows runtime executable lock preparation was cancelled.");
    }
    state.lock = lock;
  })();
  preparedExecutableLock = state;
  try {
    await state.ready;
  } catch (error) {
    if (preparedExecutableLock === state) preparedExecutableLock = null;
    throw error;
  }
}

export async function disposeWindowsRuntimeJobExecutableLock(): Promise<void> {
  const state = preparedExecutableLock;
  preparedExecutableLock = null;
  if (!state) return;
  if (state.lock) {
    try {
      await state.lock.release();
    } catch (error) {
      await state.lock.abort();
      throw error;
    }
    return;
  }
  try {
    await state.ready;
    const acquired = (state as PreparedWindowsRuntimeJobExecutableLock).lock;
    await acquired?.release();
  } catch {
    // Cancellation aborts the in-flight broker and its stdio ownership.
  }
}

function requireWindowsRuntimeJobExecutableLock(
  assembly: WindowsRuntimeJobAssembly,
): WindowsRuntimeJobExecutableLock {
  const state = preparedExecutableLock;
  if (
    !state
    || state.assemblyKey !== windowsRuntimeJobAssemblyKey(assembly)
    || !state.lock
    || !state.lock.isHeld()
  ) {
    throw new Error("The verified Windows runtime executable lock is unavailable.");
  }
  return state.lock;
}

export async function armWindowsRuntimeJob(
  runtimeGenerationId: string,
  runtimePid: number,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly timeoutMs?: number;
    readonly runtimeCreationTimeBits?: string;
    readonly assembly?: WindowsRuntimeJobAssembly;
  } = {},
): Promise<WindowsRuntimeJobContainment | null> {
  if ((options.platform ?? process.platform) !== "win32") return null;
  if (!Number.isSafeInteger(runtimePid) || runtimePid <= 1) {
    throw new Error("The Windows runtime process identity is invalid.");
  }
  const runtimeCreationTimeBits = options.runtimeCreationTimeBits;
  if (
    typeof runtimeCreationTimeBits !== "string"
    || !/^[1-9][0-9]{0,19}$/u.test(runtimeCreationTimeBits)
    || BigInt(runtimeCreationTimeBits) > 0xffff_ffff_ffff_ffffn
  ) {
    throw new Error("The Windows runtime creation identity is invalid.");
  }
  const name = windowsRuntimeJobName(runtimeGenerationId);
  if (pendingJobNames.has(name)) {
    throw new Error("The Windows runtime Job Object is already active.");
  }
  pendingJobNames.add(name);
  try {
    const startupTimeoutMs = Math.max(1, Math.min(
      options.timeoutMs ?? NATIVE_READY_TIMEOUT_MS,
      NATIVE_READY_TIMEOUT_MS,
    ));
    const deadlineAt = Date.now() + startupTimeoutMs;
    const assembly = selectedWindowsRuntimeJobAssembly(options);
    const executableLock = requireWindowsRuntimeJobExecutableLock(assembly);
    if (!executableLock.isHeld()) {
      throw new Error("The verified Windows runtime executable lock was lost before launch.");
    }
    const result = await executableLock.request(
      "guard",
      [name, String(runtimePid), runtimeCreationTimeBits],
      deadlineAt,
    );
    if (
      result.status === "READY"
      && result.stdout === "READY"
      && executableLock.isHeld()
    ) {
      return { kind: "windows-job-v1", name };
    }
    const detail = result.stderr.trim().replace(/\s+/gu, " ").slice(0, 500);
    const lastStage = latestHelperStage(result.stderr);
    const outcome = result.status.startsWith("EXIT:")
      ? `The native helper exited with code ${result.status.slice(5)}.`
      : lastStage === "native-guard-start"
        ? `The native helper did not report readiness within ${startupTimeoutMs}ms after Guard started.`
        : `The native helper did not start within ${startupTimeoutMs}ms.`;
    throw new Error([
      "The Windows runtime Job Object could not be armed.",
      outcome,
      detail,
    ].filter(Boolean).join(" "));
  } finally {
    pendingJobNames.delete(name);
  }
}

export async function recoverWindowsRuntimeJob(
  containment: WindowsRuntimeJobContainment,
  deadlineAt: number,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly assembly?: WindowsRuntimeJobAssembly;
  } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "win32") return false;
  if (Date.now() >= deadlineAt) return false;
  const assembly = selectedWindowsRuntimeJobAssembly(options);
  let executableLock: WindowsRuntimeJobExecutableLock;
  try {
    executableLock = requireWindowsRuntimeJobExecutableLock(assembly);
  } catch {
    return false;
  }
  try {
    if (!executableLock.isHeld()) return false;
    const result = await executableLock.request(
      "recover",
      [containment.name],
      deadlineAt,
    );
    return result.status === "EXIT:0" && executableLock.isHeld();
  } catch {
    return false;
  }
}
