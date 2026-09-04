import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const LINUX_RUNTIME_OWNED_GUARDIAN_HELPER_TIMEOUT_MS = 1_500;
// An immediate close can consume two readiness probes, a claim signal, an
// observed-claim confirmation after an ambiguously delivered signal, and the
// exact pending-stop signal before admission settles.
export const LINUX_RUNTIME_OWNED_GUARDIAN_IMMEDIATE_STOP_ADMISSION_TIMEOUT_MS =
  5 * LINUX_RUNTIME_OWNED_GUARDIAN_HELPER_TIMEOUT_MS;
const LINUX_GUARDIAN_HELPER_OUTPUT_BYTES = 4 * 1024;

export interface LinuxGuardianExecutableIdentity {
  readonly guardianExecutableDevice: string;
  readonly guardianExecutableInode: string;
}

interface LinuxProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startTimeTicks: string;
  readonly guardianExecutableDevice?: string;
  readonly guardianExecutableInode?: string;
}

interface LinuxGuardianHelperResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly failed: boolean;
}

type LinuxGuardianTerminalName = "inertia-done" | "inertia-exdone";

export function linuxGuardianExecutableMatches(
  guardianPath: string,
  expected: LinuxGuardianExecutableIdentity,
): boolean {
  if (!isAbsolute(guardianPath)) return false;
  try {
    const executable = statSync(guardianPath, { bigint: true });
    return executable.isFile()
      && String(executable.dev) === expected.guardianExecutableDevice
      && String(executable.ino) === expected.guardianExecutableInode;
  } catch {
    return false;
  }
}

function runLinuxGuardianHelper(
  guardianPath: string,
  args: readonly string[],
  abortSignal?: AbortSignal,
  expectedExecutable?: LinuxGuardianExecutableIdentity,
): Promise<LinuxGuardianHelperResult> {
  if (expectedExecutable
    && !linuxGuardianExecutableMatches(guardianPath, expectedExecutable)) {
    return Promise.resolve({
      stdout: "", stderr: "", status: null, signal: null, failed: true,
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failed = false;
    let child: ReturnType<typeof spawn>;
    const finish = (
      status: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abort);
      resolve({ stdout, stderr, status, signal, failed });
    };
    const stop = (): void => {
      failed = true;
      try { child.kill("SIGKILL"); } catch { /* The bounded helper already exited. */ }
    };
    const abort = (): void => stop();
    const collect = (target: "stdout" | "stderr", data: Buffer): void => {
      outputBytes += data.byteLength;
      if (outputBytes > LINUX_GUARDIAN_HELPER_OUTPUT_BYTES) {
        stop();
        return;
      }
      if (target === "stdout") stdout += data.toString("utf8");
      else stderr += data.toString("utf8");
    };
    try {
      child = spawn(guardianPath, args, {
        env: { PATH: "/usr/bin:/bin" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ stdout: "", stderr: "", status: null, signal: null, failed: true });
      return;
    }
    const timer = setTimeout(
      stop,
      LINUX_RUNTIME_OWNED_GUARDIAN_HELPER_TIMEOUT_MS,
    );
    timer.unref();
    child.stdout!.on("data", (data: Buffer) => collect("stdout", data));
    child.stderr!.on("data", (data: Buffer) => collect("stderr", data));
    child.once("error", () => { failed = true; });
    child.once("close", finish);
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) abort();
  });
}

export function verifyLinuxRuntimeOwnedGuardianSandbox(
  guardianPath: string,
): LinuxGuardianExecutableIdentity | null {
  if (!isAbsolute(guardianPath)) return null;
  const result = spawnSync(guardianPath, ["seccomp-selftest-identity"], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, shell: false,
    timeout: LINUX_RUNTIME_OWNED_GUARDIAN_HELPER_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: LINUX_GUARDIAN_HELPER_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0 || result.signal
    || result.stderr !== "") return null;
  const match = result.stdout.trim().match(
    /^[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\|([1-9][0-9]*)\|([1-9][0-9]*)$/u,
  );
  if (!match) return null;
  const identity: LinuxGuardianExecutableIdentity = {
    guardianExecutableDevice: match[1]!,
    guardianExecutableInode: match[2]!,
  };
  return linuxGuardianExecutableMatches(guardianPath, identity)
    ? identity
    : null;
}

function parsedLinuxGuardianIdentity(
  stdout: string,
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
  verifySession: boolean,
  expectedExecutable?: LinuxGuardianExecutableIdentity,
): LinuxProcessIdentity | null {
  const match = stdout.trim().match(/^([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)$/u);
  if (!match || Number(match[1]) !== pid || Number(match[2]) !== expectedParentPid
    || Number(match[3]) !== pid) return null;
  try {
    const trusted = statSync(guardianPath, { bigint: true });
    if (match[5] !== String(trusted.dev) || match[6] !== String(trusted.ino)) return null;
    if (expectedExecutable
      && (match[5] !== expectedExecutable.guardianExecutableDevice
        || match[6] !== expectedExecutable.guardianExecutableInode)) return null;
    if (verifySession) {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = stat.lastIndexOf(")");
      const fields = tail >= 0 ? stat.slice(tail + 2).trim().split(/\s+/u) : [];
      if (Number(fields[3]) !== pid) return null;
    }
    return {
      pid,
      parentPid: expectedParentPid,
      processGroupId: pid,
      startTimeTicks: match[4]!,
      guardianExecutableDevice: String(trusted.dev),
      guardianExecutableInode: String(trusted.ino),
    };
  } catch {
    return null;
  }
}

export function readLinuxGuardianReady(
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
  expectedExecutable?: LinuxGuardianExecutableIdentity,
): LinuxProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !isAbsolute(guardianPath)
    || (expectedExecutable
      && !linuxGuardianExecutableMatches(guardianPath, expectedExecutable))) return null;
  const result = spawnSync(guardianPath, ["ready", String(pid)], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, shell: false,
    timeout: LINUX_RUNTIME_OWNED_GUARDIAN_HELPER_TIMEOUT_MS,
    maxBuffer: LINUX_GUARDIAN_HELPER_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0 || result.signal || result.stderr !== "") return null;
  return parsedLinuxGuardianIdentity(
    result.stdout,
    pid,
    guardianPath,
    expectedParentPid,
    true,
    expectedExecutable,
  );
}

export async function readLinuxGuardianReadyAsync(
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
  abortSignal?: AbortSignal,
  expectedExecutable?: LinuxGuardianExecutableIdentity,
): Promise<LinuxProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !isAbsolute(guardianPath)) return null;
  const result = await runLinuxGuardianHelper(
    guardianPath,
    ["ready", String(pid)],
    abortSignal,
    expectedExecutable,
  );
  if (result.failed || result.status !== 0 || result.signal || result.stderr !== "") return null;
  return parsedLinuxGuardianIdentity(
    result.stdout,
    pid,
    guardianPath,
    expectedParentPid,
    true,
    expectedExecutable,
  );
}

export async function readLinuxGuardianReadyWithRetriesAsync(
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
  abortSignal?: AbortSignal,
  expectedExecutable?: LinuxGuardianExecutableIdentity,
): Promise<LinuxProcessIdentity | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const identity = await readLinuxGuardianReadyAsync(
      pid,
      guardianPath,
      expectedParentPid,
      abortSignal,
      expectedExecutable,
    );
    if (identity) return identity;
  }
  return null;
}

/**
 * Stops only an unauthorised guardian that is still the runtime's exact direct
 * child in the hardened ready state. This recovery boundary deliberately does
 * not claim or execute a payload and therefore does not require trusting an
 * identity result from a readiness probe that already failed.
 */
export async function stopPendingLinuxGuardianAsync(
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
  abortSignal?: AbortSignal,
  expectedExecutable?: LinuxGuardianExecutableIdentity,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1
    || !Number.isSafeInteger(expectedParentPid) || expectedParentPid <= 1
    || !isAbsolute(guardianPath)) return false;
  let helper;
  try { helper = statSync(guardianPath, { bigint: true }); } catch { return false; }
  if (expectedExecutable
    && (String(helper.dev) !== expectedExecutable.guardianExecutableDevice
      || String(helper.ino) !== expectedExecutable.guardianExecutableInode)) return false;
  const result = await runLinuxGuardianHelper(guardianPath, [
    "stop-pending",
    String(pid),
    String(expectedParentPid),
    String(helper.dev),
    String(helper.ino),
  ], abortSignal, expectedExecutable);
  return !result.failed && result.status === 0 && !result.signal
    && result.stdout === "" && result.stderr === "";
}

export function readLinuxGuardianClaimed(
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
  expectedExecutable?: LinuxGuardianExecutableIdentity,
): LinuxProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !isAbsolute(guardianPath)
    || (expectedExecutable
      && !linuxGuardianExecutableMatches(guardianPath, expectedExecutable))) return null;
  const result = spawnSync(guardianPath, ["claimed", String(pid)], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, shell: false,
    timeout: LINUX_RUNTIME_OWNED_GUARDIAN_HELPER_TIMEOUT_MS,
    maxBuffer: LINUX_GUARDIAN_HELPER_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0 || result.signal || result.stderr !== "") return null;
  return parsedLinuxGuardianIdentity(
    result.stdout,
    pid,
    guardianPath,
    expectedParentPid,
    false,
    expectedExecutable,
  );
}

async function readLinuxGuardianStateAsync(
  state: "claimed" | "owned",
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
  abortSignal?: AbortSignal,
  expectedExecutable?: LinuxGuardianExecutableIdentity,
): Promise<LinuxProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !isAbsolute(guardianPath)) return null;
  const result = await runLinuxGuardianHelper(
    guardianPath,
    [state, String(pid)],
    abortSignal,
    expectedExecutable,
  );
  if (result.failed || result.status !== 0 || result.signal || result.stderr !== "") return null;
  return parsedLinuxGuardianIdentity(
    result.stdout,
    pid,
    guardianPath,
    expectedParentPid,
    false,
    expectedExecutable,
  );
}

export function readLinuxGuardianClaimedAsync(
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
  abortSignal?: AbortSignal,
  expectedExecutable?: LinuxGuardianExecutableIdentity,
): Promise<LinuxProcessIdentity | null> {
  return readLinuxGuardianStateAsync(
    "claimed",
    pid,
    guardianPath,
    expectedParentPid,
    abortSignal,
    expectedExecutable,
  );
}

export function readLinuxGuardianOwnedAsync(
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
  abortSignal?: AbortSignal,
  expectedExecutable?: LinuxGuardianExecutableIdentity,
): Promise<LinuxProcessIdentity | null> {
  return readLinuxGuardianStateAsync(
    "owned",
    pid,
    guardianPath,
    expectedParentPid,
    abortSignal,
    expectedExecutable,
  );
}

export function linuxGuardianTerminalAuthority(
  expected: LinuxProcessIdentity,
  _guardianPath: string,
  procRoot = "/proc",
  terminalName: LinuxGuardianTerminalName = "inertia-done",
): boolean {
  try {
    const stat = readFileSync(`${procRoot}/${expected.pid}/stat`, "utf8");
    const tail = stat.lastIndexOf(")");
    const statFields = tail >= 0 ? stat.slice(tail + 2).trim().split(/\s+/u) : [];
    const fields = new Map<string, string>();
    for (const line of readFileSync(`${procRoot}/${expected.pid}/status`, "utf8").split("\n")) {
      const separator = line.indexOf(":");
      if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
    const children = readFileSync(`${procRoot}/${expected.pid}/task/${expected.pid}/children`, "utf8").trim();
    return fields.get("Name") === terminalName
      && statFields[19] === expected.startTimeTicks
      && Number(statFields[2]) === expected.processGroupId
      && (fields.get("State") ?? "").startsWith("T")
      && fields.get("TracerPid") === "0"
      && fields.get("Threads") === "1"
      && fields.get("NoNewPrivs") === "1"
      && fields.get("Seccomp") === "2"
      && (fields.get("Seccomp_filters") === undefined
        || Number(fields.get("Seccomp_filters")) >= 1)
      && children === ""
      && expected.guardianExecutableDevice !== undefined
      && expected.guardianExecutableInode !== undefined
      && expected.guardianExecutableDevice !== ""
      && expected.guardianExecutableInode !== "";
  } catch {
    return false;
  }
}

export function signalLinuxGuardianExact(
  expected: LinuxProcessIdentity,
  guardianPath: string,
  action: "claim" | "exec" | "release" | "kill" | "stop",
): boolean {
  if (!isAbsolute(guardianPath)
    || !expected.guardianExecutableDevice
    || !expected.guardianExecutableInode) return false;
  let helper;
  try { helper = statSync(guardianPath, { bigint: true }); } catch { return false; }
  if (String(helper.dev) !== expected.guardianExecutableDevice
    || String(helper.ino) !== expected.guardianExecutableInode) return false;
  const result = spawnSync(guardianPath, [
    "signal",
    String(expected.pid),
    expected.startTimeTicks,
    expected.guardianExecutableDevice,
    expected.guardianExecutableInode,
    action,
  ], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, shell: false,
    timeout: 1_500, maxBuffer: 4 * 1024,
  });
  return !result.error && result.status === 0 && !result.signal
    && result.stdout === "" && result.stderr === "";
}

/**
 * Terminates a previously admitted guardian after it has reached its hardened
 * child-free terminal state. The currently installed helper authenticates its
 * own executable separately from the prior helper identity in the durable
 * claim, so an application update cannot strand an otherwise recoverable
 * runtime generation.
 */
export function recoverLinuxGuardianTerminalExact(
  expected: LinuxProcessIdentity,
  guardianPath: string,
): boolean {
  if (!isAbsolute(guardianPath)
    || !expected.guardianExecutableDevice
    || !expected.guardianExecutableInode) return false;
  let helper;
  try { helper = statSync(guardianPath, { bigint: true }); } catch { return false; }
  const result = spawnSync(guardianPath, [
    "recover-terminal",
    String(expected.pid),
    expected.startTimeTicks,
    expected.guardianExecutableDevice,
    expected.guardianExecutableInode,
    String(helper.dev),
    String(helper.ino),
  ], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, shell: false,
    timeout: LINUX_RUNTIME_OWNED_GUARDIAN_HELPER_TIMEOUT_MS,
    maxBuffer: LINUX_GUARDIAN_HELPER_OUTPUT_BYTES,
  });
  return !result.error && result.status === 0 && !result.signal
    && result.stdout === "" && result.stderr === "";
}

export async function signalLinuxGuardianExactAsync(
  expected: LinuxProcessIdentity,
  guardianPath: string,
  action: "claim" | "exec" | "release" | "kill" | "stop",
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (!isAbsolute(guardianPath)
    || !expected.guardianExecutableDevice
    || !expected.guardianExecutableInode) return false;
  const expectedExecutable: LinuxGuardianExecutableIdentity = {
    guardianExecutableDevice: expected.guardianExecutableDevice,
    guardianExecutableInode: expected.guardianExecutableInode,
  };
  let helper;
  try { helper = statSync(guardianPath, { bigint: true }); } catch { return false; }
  if (String(helper.dev) !== expected.guardianExecutableDevice
    || String(helper.ino) !== expected.guardianExecutableInode) return false;
  const result = await runLinuxGuardianHelper(guardianPath, [
    "signal",
    String(expected.pid),
    expected.startTimeTicks,
    expected.guardianExecutableDevice,
    expected.guardianExecutableInode,
    action,
  ], abortSignal, expectedExecutable);
  return !result.failed && result.status === 0 && !result.signal
    && result.stdout === "" && result.stderr === "";
}

export function monitorLinuxGuardianTerminal(
  expected: LinuxProcessIdentity,
  guardianPath: string,
  onTerminal: (authorizationObserved: boolean) => boolean,
  onFailure: () => void,
  dependencies: {
    readonly readComm?: () => string;
    readonly terminalAuthority?: () => boolean;
    readonly release?: (abortSignal: AbortSignal) => boolean | Promise<boolean>;
    readonly missing?: () => boolean;
  } = {},
): () => void {
  let unprovedTerminalPolls = 0;
  let stopped = false;
  let releasePending = false;
  let releaseController: AbortController | null = null;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    releaseController?.abort();
    releaseController = null;
  };
  const timer = setInterval(() => {
    if (stopped || releasePending) return;
    let comm: string;
    try {
      comm = dependencies.readComm?.()
        ?? readFileSync(`/proc/${expected.pid}/comm`, "utf8").trim();
    } catch {
      if (dependencies.missing?.()) {
        stop();
        return;
      }
      stop();
      onFailure();
      return;
    }
    if (comm === "inertia-bad") {
      stop();
      onFailure();
      return;
    }
    if (comm !== "inertia-done" && comm !== "inertia-exdone") {
      unprovedTerminalPolls = 0;
      return;
    }
    if (!(dependencies.terminalAuthority?.()
      ?? linuxGuardianTerminalAuthority(expected, guardianPath, "/proc", comm))) {
      unprovedTerminalPolls += 1;
      if (unprovedTerminalPolls >= 20) {
        // A claimed terminal marker without exact hardened authority is unsafe.
        stop();
        onFailure();
      }
      return;
    }
    if (!onTerminal(comm === "inertia-exdone")) return;
    releasePending = true;
    releaseController = new AbortController();
    const release = dependencies.release
      ? dependencies.release(releaseController.signal)
      : signalLinuxGuardianExactAsync(
          expected,
          guardianPath,
          "release",
          releaseController.signal,
        );
    void Promise.resolve(release).then(
      (released) => {
        releasePending = false;
        releaseController = null;
        if (released) stop();
      },
      () => {
        releasePending = false;
        releaseController = null;
      },
    );
  }, 50);
  timer.unref();
  return stop;
}
