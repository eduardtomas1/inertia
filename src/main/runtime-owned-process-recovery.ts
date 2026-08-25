import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

import {
  type ObservedPortableProcessIdentity,
  type ObservedRuntimeOwnedProcessIdentity,
  readLinuxProcessIdentity,
  RuntimeOwnedProcessJournal,
  type RuntimeOwnedProcessClaim,
  type RuntimeOwnedProcessPlatform,
  supportedRuntimeOwnedProcessPlatform,
} from "../node/runtime-owned-processes.js";
import { forceKillRuntimeProcessTree } from "./runtime-process-tree.js";
import { RuntimeCleanupReceiptJournal } from "./runtime-cleanup-receipts.js";
import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";

type Kill = (pid: number, signal?: NodeJS.Signals | number) => true;

export interface RuntimeOwnedProcessRecoveryOptions {
  readonly deadlineAt: number;
  readonly platform?: NodeJS.Platform;
  readonly kill?: Kill;
  readonly forceKill?: typeof forceKillRuntimeProcessTree;
  readonly readIdentity?: (
    pid: number,
  ) => ObservedRuntimeOwnedProcessIdentity | null;
}

const WINDOWS_EPOCH_TICKS = 621_355_968_000_000_000n;

export function readDarwinProcessIdentity(
  pid: number,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly deadlineAt?: number;
    readonly spawnProcessSync?: typeof spawnSync;
  } = {},
): ObservedPortableProcessIdentity | null {
  if ((options.platform ?? process.platform) !== "darwin"
    || !Number.isSafeInteger(pid) || pid <= 1) return null;
  const remainingMs = Math.trunc(
    (options.deadlineAt ?? Date.now() + 1_000) - Date.now(),
  );
  if (remainingMs <= 0) {
    throw new Error("The macOS owned process identity deadline expired.");
  }
  const result = (options.spawnProcessSync ?? spawnSync)(
    "/bin/ps",
    ["-p", String(pid), "-o", "pid=,pgid=,lstart="],
    {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 4_096,
      shell: false,
      timeout: Math.max(1, Math.min(1_000, remainingMs)),
    },
  );
  if (result.error) throw result.error;
  if (result.status === 1 && !result.stdout?.trim()) return null;
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("The macOS owned process identity could not be read.");
  }
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
  const parsedPid = Number(match?.[1]);
  const processGroupId = Number(match?.[2]);
  const startedAtMs = Date.parse(match?.[3] ?? "");
  if (
    parsedPid !== pid
    || !Number.isSafeInteger(processGroupId)
    || processGroupId <= 1
    || !Number.isSafeInteger(startedAtMs)
    || startedAtMs < 0
  ) throw new Error("The macOS owned process identity is invalid.");
  return { platform: "darwin", pid, processGroupId, startedAtMs };
}

function inheritedWindowsRoot(
  environment: NodeJS.ProcessEnv,
): string | null {
  const value = (name: string): string | undefined =>
    Object.entries(environment).find(([key]) =>
      key.toLowerCase() === name)?.[1];
  const candidate = (value("systemroot") ?? value("windir"))?.trim();
  return candidate && win32.isAbsolute(candidate)
    ? win32.normalize(candidate)
    : null;
}

export function readWindowsProcessIdentity(
  pid: number,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly deadlineAt?: number;
    readonly environment?: NodeJS.ProcessEnv;
    readonly spawnProcessSync?: typeof spawnSync;
  } = {},
): ObservedPortableProcessIdentity | null {
  if ((options.platform ?? process.platform) !== "win32"
    || !Number.isSafeInteger(pid) || pid <= 1) return null;
  const environment = options.environment ?? process.env;
  const windowsRoot = inheritedWindowsRoot(environment);
  const remainingMs = Math.trunc(
    (options.deadlineAt ?? Date.now() + 1_000) - Date.now(),
  );
  if (!windowsRoot) {
    throw new Error("The Windows system root is unavailable.");
  }
  if (remainingMs <= 0) {
    throw new Error("The Windows owned process identity deadline expired.");
  }
  const executable = win32.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = "$ErrorActionPreference = 'Stop'; "
    + `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
    + "if ($null -eq $process) { [Console]::Out.Write('missing') } "
    + "else { [Console]::Out.Write('found|' + $process.StartTime.ToUniversalTime().Ticks) }";
  const probeEnvironment: NodeJS.ProcessEnv = {
    ComSpec: win32.join(windowsRoot, "System32", "cmd.exe"),
    PATH: win32.join(windowsRoot, "System32"),
    SystemRoot: windowsRoot,
    SYSTEMROOT: windowsRoot,
    WINDIR: windowsRoot,
  };
  const result = (options.spawnProcessSync ?? spawnSync)(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: probeEnvironment,
      maxBuffer: 4_096,
      shell: false,
      timeout: Math.max(1, Math.min(1_000, remainingMs)),
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("The Windows owned process identity could not be read.");
  }
  if (typeof result.stdout !== "string") {
    throw new Error("The Windows owned process identity is invalid.");
  }
  const output = result.stdout.trim();
  if (output === "missing") return null;
  const rawTicks = output.match(/^found\|([1-9][0-9]{10,20})$/u)?.[1]
    ?? "";
  if (!/^[1-9][0-9]{10,20}$/u.test(rawTicks)) {
    throw new Error("The Windows owned process identity is invalid.");
  }
  const milliseconds = (BigInt(rawTicks) - WINDOWS_EPOCH_TICKS) / 10_000n;
  const startedAtMs = Number(milliseconds);
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
    throw new Error("The Windows owned process identity is invalid.");
  }
  return { platform: "win32", pid, processGroupId: null, startedAtMs };
}

function readProcessIdentity(
  pid: number,
  platform: RuntimeOwnedProcessPlatform,
  deadlineAt: number,
): ObservedRuntimeOwnedProcessIdentity | null {
  if (platform === "linux") return readLinuxProcessIdentity(pid);
  if (platform === "darwin") {
    return readDarwinProcessIdentity(pid, { deadlineAt });
  }
  return readWindowsProcessIdentity(pid, { deadlineAt });
}

function verifiedKill(
  claim: RuntimeOwnedProcessClaim,
  kill: Kill,
  readIdentity: (
    pid: number,
  ) => ObservedRuntimeOwnedProcessIdentity | null,
): Kill {
  return (target, signal) => {
    if (Math.abs(target) === claim.process.pid) {
      const identity = readIdentity(claim.process.pid);
      if (
        !identity
        || !RuntimeOwnedProcessJournal.identityMatches(claim, identity)
      ) {
        const error = new Error("The owned process identity changed.") as
          Error & { code: string };
        error.code = "ESRCH";
        throw error;
      }
    }
    return kill(target, signal);
  };
}

function claimMatchesPlatform(
  claim: RuntimeOwnedProcessClaim,
  platform: RuntimeOwnedProcessPlatform,
): boolean {
  return platform === "linux"
    ? "startTimeTicks" in claim.process
    : "platform" in claim.process && claim.process.platform === platform;
}

function missingRootCleanupConfirmed(
  claim: RuntimeOwnedProcessClaim,
  platform: RuntimeOwnedProcessPlatform,
  kill: Kill,
): boolean {
  // Windows process lifecycle already treats a fully closed direct child as
  // retired and never retargets that numeric PID. macOS can additionally
  // prove the detached process group is absent with a no-signal probe.
  if (platform === "win32") return true;
  if (platform !== "darwin") return false;
  try {
    kill(-claim.process.pid, 0);
    return false;
  } catch (error) {
    return Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ESRCH",
    );
  }
}

/**
 * Recovers one durable generation without guessing process ownership.
 *
 * A pending claim represents the crash window between durable spawn intent and
 * an exact child identity, so it stays fail-closed. Owned claims are killed
 * only while their platform-specific birth identity still matches. Reused
 * roots stay fail-closed and are never signalled. Linux missing roots remain
 * fail-closed; Windows follows its direct-child-close contract, while macOS
 * requires proof that the claimed process group is absent.
 */
export function recoverRuntimeOwnedProcesses(
  dataDirectory: string,
  runtimeGenerationId: string,
  systemBootId: string,
  options: RuntimeOwnedProcessRecoveryOptions,
): boolean | Promise<boolean> | null {
  const platform = options.platform ?? process.platform;
  if (!supportedRuntimeOwnedProcessPlatform(platform)) return null;
  const journal = new RuntimeOwnedProcessJournal(dataDirectory, { platform });
  const records = journal.records(runtimeGenerationId);
  if (!records) return null;
  if (records.length === 0) return true;
  // One intentionally narrow residual window: spawn intent is durable, but
  // no exact OS identity exists yet to authorize a kill.
  if (records.some((record) => record.state === "pending")) {
    return Promise.resolve(false);
  }
  return (async () => {
    const kill = options.kill ?? process.kill;
    const forceKill = options.forceKill ?? forceKillRuntimeProcessTree;
    const readIdentity = options.readIdentity
      ?? ((pid: number) => readProcessIdentity(pid, platform, options.deadlineAt));
    for (const record of records) {
      if (record.state !== "owned") return false;
      if (!claimMatchesPlatform(record, platform)) return false;
      if (record.systemBootId !== systemBootId) {
        if (!journal.release(record.ownershipId)) return false;
        continue;
      }
      let identity;
      try {
        identity = readIdentity(record.process.pid);
      } catch {
        return false;
      }
      if (!identity) {
        if (
          !missingRootCleanupConfirmed(record, platform, kill)
          || !journal.release(record.ownershipId)
        ) return false;
        continue;
      }
      if (!RuntimeOwnedProcessJournal.identityMatches(record, identity)) return false;
      if (
        (platform !== "win32" && identity.processGroupId !== identity.pid)
        || Date.now() >= options.deadlineAt
      ) return false;
      if (platform === "win32") {
        let immediateIdentity;
        try { immediateIdentity = readIdentity(record.process.pid); } catch { return false; }
        if (!immediateIdentity) {
          if (!journal.release(record.ownershipId)) return false;
          continue;
        }
        if (!RuntimeOwnedProcessJournal.identityMatches(record, immediateIdentity)) {
          return false;
        }
      }
      const confirmed = await forceKill(identity.pid, {
        rootProcessGroup: platform !== "win32",
        deadlineAt: options.deadlineAt,
        kill: verifiedKill(record, kill, readIdentity),
      }).catch(() => false);
      if (!confirmed || !journal.release(record.ownershipId)) return false;
    }
    return true;
  })();
}

export function recoverPriorRuntimeGenerations(options: {
  dataDirectory: string;
  systemBootId: string;
  deadlineAt: number;
  leases: RuntimeGenerationLeaseJournal;
  receipts: RuntimeCleanupReceiptJournal;
  platform?: NodeJS.Platform;
}): Promise<boolean> | null {
  const platform = options.platform ?? process.platform;
  if (!supportedRuntimeOwnedProcessPlatform(platform)) return null;
  options.leases.refresh();
  const prior = options.leases.all().filter((lease) =>
    lease.systemBootId === options.systemBootId);
  if (prior.length === 0) return null;
  const journal = new RuntimeOwnedProcessJournal(options.dataDirectory, {
    platform,
  });
  if (prior.some((lease) => journal.records(lease.runtimeGenerationId) === null)) {
    return null;
  }
  return (async () => {
    for (const lease of prior) {
      const recovered = recoverRuntimeOwnedProcesses(
        options.dataDirectory,
        lease.runtimeGenerationId,
        options.systemBootId,
        { deadlineAt: options.deadlineAt, platform },
      );
      if (!recovered || !await recovered) return false;
    }
    for (const lease of prior) {
      if (
        !journal.finishSession(lease.runtimeGenerationId)
        || !options.receipts.publish(lease.runtimeGenerationId)
        || !options.leases.clearRuntimeGeneration(lease.runtimeGenerationId)
      ) return false;
    }
    return true;
  })();
}

export function finishRuntimeOwnedProcessSession(
  dataDirectory: string,
  runtimeGenerationId: string,
): boolean {
  if (!supportedRuntimeOwnedProcessPlatform(process.platform)) return true;
  try {
    return new RuntimeOwnedProcessJournal(dataDirectory)
      .finishSession(runtimeGenerationId);
  } catch {
    return false;
  }
}
