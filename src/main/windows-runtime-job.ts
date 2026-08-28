import { createHash, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

import windowsRuntimeJobIntegrity from
  "../../resources/generated/windows-runtime-job-integrity.json";
import type { WindowsRuntimeJobContainment } from "../node/runtime-owned-processes.js";
import { validRuntimeGenerationId } from "../node/runtime-process-protocol.js";
import {
  resolveWindowsRuntimeJobAssemblyPath,
  type RuntimeAssetLocations,
} from "./runtime-assets.js";

const NATIVE_READY_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8_192;
const MAX_PROCESS_METRICS = 1_024;
const PROCESS_METRIC_POLL_MS = 10;
const PROCESS_METRIC_TIMEOUT_MS = 5_000;
const MAX_PROCESS_METRIC_ATTEMPTS = 500;
const MAX_WINDOWS_JOB_ASSEMBLY_BYTES = 1024 * 1024;

type WindowsRuntimeJobStage = "native-guard-start";

interface ActiveWindowsRuntimeJob {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completion: Promise<boolean>;
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

const activeJobs = new Map<string, ActiveWindowsRuntimeJob>();

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
  return assembly;
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
  readonly spawnProcess?: typeof spawnWindowsRuntimeJobExecutable;
}): WindowsRuntimeJobAssembly {
  if (!options.assembly) {
    throw new Error("The Windows runtime Job Object assembly authority is unavailable.");
  }
  // An injected process is the unit-test boundary. Production always validates
  // the exact protected digest and direct file before starting the executable.
  return options.spawnProcess
    ? normalizedWindowsRuntimeJobAssembly(options.assembly)
    : validateWindowsRuntimeJobAssembly(options.assembly);
}

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
}

function latestHelperStage(output: string): WindowsRuntimeJobStage | null {
  const matches = output.matchAll(
    /INERTIA_JOB_STAGE stage=(native-guard-start)/gu,
  );
  let latest: WindowsRuntimeJobStage | null = null;
  for (const match of matches) latest = match[1] as WindowsRuntimeJobStage;
  return latest;
}

function spawnWindowsRuntimeJobExecutable(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const trustedEnvironment = windowsRuntimeJobEnvironment(environment);
  if (!trustedEnvironment) {
    throw new Error("The trusted Windows runtime environment is unavailable.");
  }
  return spawn(
    executable,
    [...arguments_],
    {
      env: trustedEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

export async function armWindowsRuntimeJob(
  runtimeGenerationId: string,
  runtimePid: number,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly runtimeCreationTimeBits?: string;
    readonly assembly?: WindowsRuntimeJobAssembly;
    readonly spawnProcess?: typeof spawnWindowsRuntimeJobExecutable;
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
  if (activeJobs.has(name)) {
    throw new Error("The Windows runtime Job Object is already active.");
  }
  const assembly = selectedWindowsRuntimeJobAssembly(options);
  const child = (options.spawnProcess ?? spawnWindowsRuntimeJobExecutable)(
    assembly.path,
    [
      "guard",
      name,
      String(runtimePid),
      runtimeCreationTimeBits,
      assembly.sha256,
    ],
    options.environment ?? process.env,
  );
  let stdout = "";
  let stderr = "";
  let ready = false;
  let settleCompletion!: (confirmed: boolean) => void;
  const completion = new Promise<boolean>((resolve) => {
    settleCompletion = resolve;
  });
  activeJobs.set(name, { child, completion });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.once("exit", (code) => {
    activeJobs.delete(name);
    settleCompletion(code === 0);
  });
  child.once("error", () => {
    activeJobs.delete(name);
    settleCompletion(false);
  });

  const startupTimeoutMs = Math.max(1, Math.min(
    options.timeoutMs ?? NATIVE_READY_TIMEOUT_MS,
    NATIVE_READY_TIMEOUT_MS,
  ));
  const deadlineAt = Date.now() + startupTimeoutMs;
  let lastStage: WindowsRuntimeJobStage | null = null;
  while (true) {
    if (stdout.split(/\r?\n/u).includes("READY")) {
      ready = true;
      break;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    const observedStage = latestHelperStage(stderr);
    if (observedStage !== null) lastStage = observedStage;
    if (Date.now() >= deadlineAt) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!ready) {
    child.kill();
    activeJobs.delete(name);
    const detail = stderr.trim().replace(/\s+/gu, " ").slice(0, 500);
    const outcome = child.exitCode !== null
      ? `The native helper exited with code ${child.exitCode}.`
      : child.signalCode
        ? `The native helper exited from signal ${child.signalCode}.`
        : lastStage === "native-guard-start"
          ? `The native helper did not report readiness within ${startupTimeoutMs}ms after Guard started.`
          : `The native helper did not start within ${startupTimeoutMs}ms.`;
    throw new Error([
      "The Windows runtime Job Object could not be armed.",
      outcome,
      detail,
    ].filter(Boolean).join(" "));
  }
  return { kind: "windows-job-v1", name };
}

export async function recoverWindowsRuntimeJob(
  containment: WindowsRuntimeJobContainment,
  deadlineAt: number,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly assembly?: WindowsRuntimeJobAssembly;
    readonly spawnProcess?: typeof spawnWindowsRuntimeJobExecutable;
  } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "win32") return false;
  if (Date.now() >= deadlineAt) return false;
  const active = activeJobs.get(containment.name);
  if (active) {
    const remainingMs = Math.max(1, Math.trunc(deadlineAt - Date.now()));
    return await Promise.race([
      active.completion,
      new Promise<false>((resolve) => setTimeout(resolve, remainingMs, false)),
    ]);
  }
  const assembly = selectedWindowsRuntimeJobAssembly(options);
  const child = (options.spawnProcess ?? spawnWindowsRuntimeJobExecutable)(
    assembly.path,
    ["recover", containment.name, assembly.sha256],
    options.environment ?? process.env,
  );
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(confirmed);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(false);
    }, Math.max(1, Math.trunc(deadlineAt - Date.now())));
    child.once("error", () => settle(false));
    child.once("exit", (code) => settle(code === 0));
  });
}
