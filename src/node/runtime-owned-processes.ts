import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  darwinProcessGuardianReady,
  darwinProcessGuardianReadyAsync,
  darwinProcessSessionEmptyAsync,
  readDarwinProcessIdentity,
  readDarwinProcessIdentityAsync,
  type DarwinProcessIdentity,
} from "./runtime-owned-process-darwin.js";
import {
  exactProcessGroupAbsent,
  failedClaimProcessCanExecute,
} from "./runtime-owned-process-posix.js";
import {
  monitorLinuxGuardianTerminal,
  readLinuxGuardianClaimedAsync,
  readLinuxGuardianOwnedAsync,
  readLinuxGuardianReadyWithRetriesAsync,
  signalLinuxGuardianExact,
  signalLinuxGuardianExactAsync,
  stopPendingLinuxGuardianAsync,
} from "./runtime-owned-process-linux.js";
import {
  RuntimeOwnedProcessJournal,
  sameProcess,
  supportedRuntimeOwnedProcessPlatform,
  type LinuxProcessIdentity,
  type RuntimeOwnedProcessClaim,
  type RuntimeOwnedProcessPlatform,
} from "./runtime-owned-process-journal.js";
export {
  RuntimeOwnedProcessJournal,
  readLinuxProcessIdentity,
  supportedRuntimeOwnedProcessPlatform,
} from "./runtime-owned-process-journal.js";
export type {
  LinuxProcessIdentity,
  ObservedRuntimeOwnedProcessIdentity,
  ObservedWindowsProcessIdentity,
  RuntimeOwnedDarwinProcessPending,
  RuntimeOwnedLinuxProcessPending,
  RuntimeOwnedProcessClaim,
  RuntimeOwnedProcessContainment,
  RuntimeOwnedProcessIdentity,
  RuntimeOwnedProcessPlatform,
  WindowsProcessIdentity,
  WindowsRuntimeJobContainment,
} from "./runtime-owned-process-journal.js";
export {
  darwinProcessGuardianReady,
  darwinProcessGuardianReadyAsync,
  darwinProcessSessionEmpty,
  darwinProcessSessionEmptyAsync,
  readDarwinProcessIdentity,
  readDarwinProcessIdentityAsync,
} from "./runtime-owned-process-darwin.js";
export type { DarwinProcessIdentity } from "./runtime-owned-process-darwin.js";

const PROCESS_GROUP_EXIT_WAIT_MS = 1_000;
const PROCESS_GROUP_EXIT_POLL_MS = 10;
interface ActiveRuntimeOwnedProcessRegistry {
  readonly journal: RuntimeOwnedProcessJournal;
  readonly platform: RuntimeOwnedProcessPlatform;
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
  readonly darwinGuardianPath: string | null;
  readonly readDarwinIdentity: (
    pid: number,
  ) => DarwinProcessIdentity | null;
  readonly readDarwinGuardianReady: (
    pid: number,
  ) => DarwinProcessIdentity | null;
  readonly readDarwinIdentityAsync: (
    pid: number,
    abortSignal?: AbortSignal,
  ) => Promise<DarwinProcessIdentity | null>;
  readonly readDarwinGuardianReadyAsync: (
    pid: number,
    abortSignal?: AbortSignal,
  ) => Promise<DarwinProcessIdentity | null>;
  readonly readDarwinSessionEmptyAsync: (
    sessionId: number,
    abortSignal?: AbortSignal,
  ) => Promise<boolean | null>;
  readonly claims: WeakMap<ChildProcess, ActiveRuntimeOwnedProcessClaim>;
  readonly activeLinuxMonitors: Set<() => void>;
  readonly admissionController: AbortController;
  readonly pendingAdmissions: Set<Promise<boolean>>;
  readonly pendingReleaseConfirmations: Set<Promise<boolean>>;
  tainted: boolean;
}

interface ActiveRuntimeOwnedProcessClaim {
  readonly ownershipId: string;
  released: boolean;
  stopRequested: boolean;
  authorizationObserved: boolean;
  admissionSucceeded: boolean;
  groupExitReleaseAttempts: number;
  admission: Promise<boolean> | null;
  releaseConfirmation: Promise<boolean> | null;
  settleReleaseConfirmation: ((confirmed: boolean) => void) | null;
  linuxIdentity?: LinuxProcessIdentity;
  darwinIdentity?: DarwinProcessIdentity;
  settleLinuxMonitorConfirmation?: (confirmed: boolean) => void;
  stopLinuxMonitor?: () => void;
}

let activeRegistry: ActiveRuntimeOwnedProcessRegistry | null = null;

export function activateRuntimeOwnedProcessRegistry(
  dataDirectory: string,
  runtimeGenerationId: string,
  systemBootId: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly darwinGuardianPath?: string;
    readonly readDarwinIdentity?: (
      pid: number,
    ) => DarwinProcessIdentity | null;
    readonly readDarwinGuardianReady?: (
      pid: number,
    ) => DarwinProcessIdentity | null;
    readonly readDarwinIdentityAsync?: (
      pid: number,
      abortSignal?: AbortSignal,
    ) => Promise<DarwinProcessIdentity | null>;
    readonly readDarwinGuardianReadyAsync?: (
      pid: number,
      abortSignal?: AbortSignal,
    ) => Promise<DarwinProcessIdentity | null>;
    readonly readDarwinSessionEmptyAsync?: (
      sessionId: number,
      abortSignal?: AbortSignal,
    ) => Promise<boolean | null>;
  } = {},
): (() => void) | null {
  const platform = options.platform ?? process.platform;
  if (!supportedRuntimeOwnedProcessPlatform(platform)) return null;
  if (activeRegistry) {
    throw new Error("The runtime process ownership registry is already active.");
  }
  const darwinGuardianPath = options.darwinGuardianPath ?? null;
  if (
    (platform === "darwin" || platform === "linux")
    && (!darwinGuardianPath || !isAbsolute(darwinGuardianPath))
  ) throw new Error("The runtime process guardian is unavailable.");
  const journal = new RuntimeOwnedProcessJournal(dataDirectory, {
    platform,
    ...(darwinGuardianPath ? { darwinGuardianPath } : {}),
    ...(options.readDarwinIdentity
      ? { readDarwinIdentity: options.readDarwinIdentity }
      : {}),
    ...(options.readDarwinGuardianReady
      ? { readDarwinGuardianReady: options.readDarwinGuardianReady }
      : {}),
  });
  if (!journal.startSession(runtimeGenerationId, systemBootId)) {
    throw new Error("The runtime process ownership session could not be persisted.");
  }
  const registry: ActiveRuntimeOwnedProcessRegistry = {
    journal,
    platform,
    runtimeGenerationId,
    systemBootId,
    darwinGuardianPath,
    readDarwinIdentity: options.readDarwinIdentity
      ?? ((pid) => darwinGuardianPath
        ? readDarwinProcessIdentity(pid, darwinGuardianPath)
        : null),
    readDarwinGuardianReady: options.readDarwinGuardianReady
      ?? ((pid) => darwinGuardianPath
        ? darwinProcessGuardianReady(pid, darwinGuardianPath)
        : null),
    readDarwinIdentityAsync: options.readDarwinIdentityAsync
      ?? (options.readDarwinIdentity
        ? async (pid) => options.readDarwinIdentity!(pid)
        : async (pid, abortSignal) => darwinGuardianPath
          ? await readDarwinProcessIdentityAsync(pid, darwinGuardianPath, abortSignal)
          : null),
    readDarwinGuardianReadyAsync: options.readDarwinGuardianReadyAsync
      ?? (options.readDarwinGuardianReady
        ? async (pid) => options.readDarwinGuardianReady!(pid)
        : async (pid, abortSignal) => darwinGuardianPath
          ? await darwinProcessGuardianReadyAsync(pid, darwinGuardianPath, abortSignal)
          : null),
    readDarwinSessionEmptyAsync: options.readDarwinSessionEmptyAsync
      ?? (async (sessionId, abortSignal) => darwinGuardianPath
        ? await darwinProcessSessionEmptyAsync(
            sessionId,
            darwinGuardianPath,
            abortSignal,
          )
        : null),
    claims: new WeakMap(),
    activeLinuxMonitors: new Set(),
    admissionController: new AbortController(),
    pendingAdmissions: new Set(),
    pendingReleaseConfirmations: new Set(),
    tainted: false,
  };
  activeRegistry = registry;
  return () => {
    if (activeRegistry !== registry) return;
    activeRegistry = null;
    registry.admissionController.abort();
    for (const stopMonitor of registry.activeLinuxMonitors) stopMonitor();
    registry.activeLinuxMonitors.clear();
  };
}

export interface RuntimeOwnedProcessInvocation {
  readonly command: string;
  readonly args: string[];
}

/**
 * Places each macOS runtime child in a private process session and performs
 * bounded best-effort cleanup of the processes still attributable to it.
 * macOS exposes no unprivileged job primitive that can prove containment of
 * an arbitrary descendant after it double-forks and calls setsid(); normal
 * completed commands therefore preserve Git/provider fork compatibility,
 * while cancellation or runtime-authority loss remains fail-closed.
 * The helper always execs the requested program without a shell.
 */
export function runtimeOwnedProcessInvocation(
  command: string,
  args: readonly string[],
): RuntimeOwnedProcessInvocation {
  const registry = activeRegistry;
  if (registry?.platform !== "darwin" && registry?.platform !== "linux") {
    return { command, args: [...args] };
  }
  if (!registry.darwinGuardianPath) {
    throw new Error("The runtime process guardian is unavailable.");
  }
  if (registry.platform === "linux") {
    const executable = statSync(registry.darwinGuardianPath, { bigint: true });
    if (!executable.isFile()) throw new Error("The Linux runtime process guardian is invalid.");
    return {
      command: registry.darwinGuardianPath,
      args: [
        "watch", String(process.pid), String(executable.dev), String(executable.ino),
        "--", command, ...args,
      ],
    };
  }
  return {
    command: registry.darwinGuardianPath,
    args: ["watch", String(process.pid), "--", command, ...args],
  };
}

export function activeRuntimeOwnedProcessPlatform(): RuntimeOwnedProcessPlatform | null {
  return activeRegistry?.platform ?? null;
}

/**
 * Requests the platform guardian to drain an exact actively-owned child and
 * returns the bounded admission/stop barrier that owns that request.
 */
export function requestRuntimeOwnedGuardianStop(
  child: ChildProcess,
): Promise<boolean> | null {
  const registry = activeRegistry;
  if (!registry || (registry.platform !== "darwin" && registry.platform !== "linux")) {
    return null;
  }
  const claim = registry.claims.get(child);
  if (!claim || claim.released || !child.pid) return null;
  if (registry.platform === "linux") {
    claim.stopRequested = true;
    if (claim.admission) return claim.admission;
    if (claim.linuxIdentity && registry.darwinGuardianPath) {
      return signalLinuxGuardianExactAsync(
        claim.linuxIdentity,
        registry.darwinGuardianPath,
        "stop",
      );
    }
    // A known Linux guardian always owns this stop attempt. Failure to prove
    // the exact helper signal is reported through the barrier with its durable
    // claim retained; the caller must never use an unsafe raw-PID fallback.
    return Promise.resolve(false);
  }
  claim.stopRequested = true;
  if (claim.admission) return claim.admission;
  if (claim.darwinIdentity) {
    try { return Promise.resolve(child.kill("SIGTERM")); } catch {
      return Promise.resolve(false);
    }
  }
  // The guardian owns the stop even while asynchronous admission is pending;
  // never authorize a caller fallback against a recyclable raw PID.
  return Promise.resolve(false);
}

function hardStopUnclaimed(
  child: Pick<ChildProcess, "pid" | "kill">,
  platform: NodeJS.Platform,
): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch { /* The group may be gone. */ }
  }
  try { child.kill("SIGKILL"); } catch { /* The child may be gone. */ }
}

async function hardStopUnclaimedDarwinGuardian(
  child: Pick<ChildProcess, "pid" | "kill">,
  registry: ActiveRuntimeOwnedProcessRegistry,
  expectedIdentity: DarwinProcessIdentity | null,
): Promise<void> {
  const pid = child.pid;
  if (!pid || !expectedIdentity || !registry.darwinGuardianPath) return;
  let current: DarwinProcessIdentity | null = null;
  try {
    current = await registry.readDarwinIdentityAsync(
      pid,
      registry.admissionController.signal,
    );
  } catch {
    return;
  }
  if (!current || !sameProcess(expectedIdentity, current)) return;
  try { child.kill("SIGKILL"); } catch { /* The exact guardian may be gone. */ }
}

function exactUnownedClaim(
  registry: ActiveRuntimeOwnedProcessRegistry,
  ownershipId: string,
): boolean {
  const records = registry.journal.records(registry.runtimeGenerationId);
  if (!records) return false;
  const matching = records.filter((record) =>
    record.ownershipId === ownershipId);
  return matching.length === 1
    && (matching[0]?.state === "pending" || matching[0]?.state === "preauth")
    && matching[0].runtimeGenerationId === registry.runtimeGenerationId
    && matching[0].systemBootId === registry.systemBootId;
}

interface RuntimeOwnedPidProcessOptions {
  readonly processCanExecute?: (pid: number) => boolean | null;
  readonly darwinGuardianCommand?: string;
}

function releaseFailedPidClaimIfStopped(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  pid: number,
  processCanExecute: (pid: number) => boolean | null,
): Promise<boolean> {
  if (claim.releaseConfirmation) return claim.releaseConfirmation;
  let settleConfirmation!: (confirmed: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => {
    settleConfirmation = resolve;
  });
  claim.releaseConfirmation = confirmation;
  claim.settleReleaseConfirmation = settleConfirmation;
  registry.pendingReleaseConfirmations.add(confirmation);
  void confirmation.then(() => {
    registry.pendingReleaseConfirmations.delete(confirmation);
    claim.settleReleaseConfirmation = null;
  });
  const deadlineAt = Date.now() + PROCESS_GROUP_EXIT_WAIT_MS;
  const poll = (): void => {
    if (
      activeRegistry !== registry
      || claim.released
      || !exactUnownedClaim(registry, claim.ownershipId)
    ) {
      settleConfirmation(claim.released);
      return;
    }
    const executable = processCanExecute(pid);
    if (executable === false && exactProcessGroupAbsent(pid) === true) {
      try {
        if (!registry.journal.release(claim.ownershipId)) {
          settleConfirmation(false);
          return;
        }
        claim.stopLinuxMonitor?.();
        claim.released = true;
        claim.settleLinuxMonitorConfirmation?.(true);
        settleConfirmation(true);
      } catch {
        settleConfirmation(false);
      }
      return;
    }
    const remainingMs = Math.trunc(deadlineAt - Date.now());
    if (remainingMs <= 0) {
      settleConfirmation(false);
      return;
    }
    const timer = setTimeout(
      poll,
      Math.max(1, Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs)),
    );
    timer.unref();
  };
  poll();
  return confirmation;
}

function releaseIfGroupExited(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  pid: number,
): Promise<boolean> {
  if (claim.releaseConfirmation) return claim.releaseConfirmation;
  if (claim.released) return Promise.resolve(true);
  let settleConfirmation!: (confirmed: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => {
    settleConfirmation = resolve;
  });
  claim.groupExitReleaseAttempts += 1;
  claim.releaseConfirmation = confirmation;
  claim.settleReleaseConfirmation = settleConfirmation;
  registry.pendingReleaseConfirmations.add(confirmation);
  void confirmation.then((confirmed) => {
    registry.pendingReleaseConfirmations.delete(confirmation);
    claim.settleReleaseConfirmation = null;
    if (
      !confirmed
      && activeRegistry === registry
      && !claim.released
      && claim.releaseConfirmation === confirmation
    ) {
      claim.releaseConfirmation = null;
      // A guardian can become reapable immediately after the first bounded
      // absence check expires, especially under host contention. Retry once
      // within the worker's shutdown budget; a second failure remains durable
      // and fails closed.
      if (claim.groupExitReleaseAttempts < 2) {
        void releaseIfGroupExited(registry, claim, pid);
      }
    }
  });
  const deadlineAt = Date.now() + PROCESS_GROUP_EXIT_WAIT_MS;
  const poll = async (): Promise<void> => {
    if (activeRegistry !== registry) {
      settleConfirmation(false);
      return;
    }
    if (claim.released) {
      settleConfirmation(true);
      return;
    }
    try {
      const containmentAbsent = registry.platform === "darwin"
        ? await registry.readDarwinSessionEmptyAsync(
            pid,
            registry.admissionController.signal,
          ) === true
        : exactProcessGroupAbsent(pid) === true;
      if (containmentAbsent) {
        try {
          if (!releaseActiveClaim(registry, claim)) settleConfirmation(false);
        } catch {
          // A removed test/runtime root cannot authorize further mutation.
          settleConfirmation(false);
        }
        return;
      }
    } catch {
      // An unreadable containment boundary remains durably owned.
    }
    const remainingMs = Math.trunc(deadlineAt - Date.now());
    if (remainingMs <= 0) {
      settleConfirmation(false);
      return;
    }
    const timer = setTimeout(
      () => { void poll(); },
      Math.max(1, Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs)),
    );
    timer.unref();
  };
  void poll();
  return confirmation;
}

function releaseActiveClaim(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
): boolean {
  if (claim.released) return true;
  if (!(registry.platform === "linux"
    ? registry.journal.releaseRetiring(claim.ownershipId)
    : registry.journal.release(claim.ownershipId))) return false;
  claim.stopLinuxMonitor?.();
  claim.released = true;
  claim.settleLinuxMonitorConfirmation?.(true);
  claim.settleReleaseConfirmation?.(true);
  return true;
}

function monitorLinuxGuardian(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  durableClaim: RuntimeOwnedProcessClaim,
): void {
  if (
    registry.platform !== "linux"
    || !registry.darwinGuardianPath
    || !("startTimeTicks" in durableClaim.process)
  ) return;
  claim.linuxIdentity = durableClaim.process;
  let settleLinuxMonitorConfirmation!: (confirmed: boolean) => void;
  const linuxMonitorConfirmation = new Promise<boolean>((resolve) => {
    settleLinuxMonitorConfirmation = resolve;
  });
  claim.settleLinuxMonitorConfirmation = settleLinuxMonitorConfirmation;
  registry.pendingReleaseConfirmations.add(linuxMonitorConfirmation);
  void linuxMonitorConfirmation.then(() => {
    registry.pendingReleaseConfirmations.delete(linuxMonitorConfirmation);
    claim.settleLinuxMonitorConfirmation = undefined;
  });
  let stopMonitor: (() => void) | null = null;
  const stopTrackedMonitor = (): void => {
    registry.activeLinuxMonitors.delete(stopTrackedMonitor);
    const stop = stopMonitor;
    stopMonitor = null;
    stop?.();
  };
  stopMonitor = monitorLinuxGuardianTerminal(
    durableClaim.process,
    registry.darwinGuardianPath,
    (authorizationObserved) => {
      const retired = registry.journal.retire(claim.ownershipId);
      if (retired && authorizationObserved) claim.authorizationObserved = true;
      return retired;
    },
    () => {
      registry.activeLinuxMonitors.delete(stopTrackedMonitor);
      claim.stopLinuxMonitor = undefined;
      registry.tainted = true;
      settleLinuxMonitorConfirmation(false);
    },
    {
      release: async (abortSignal) => {
        if (await signalLinuxGuardianExactAsync(
          durableClaim.process as LinuxProcessIdentity,
          registry.darwinGuardianPath!,
          "release",
          abortSignal,
        )) return true;
        if (exactProcessGroupAbsent(durableClaim.process.pid) !== true) return false;
        try { return releaseActiveClaim(registry, claim); } catch { return false; }
      },
      missing: () => {
        if (exactProcessGroupAbsent(durableClaim.process.pid) !== true) return false;
        if (!registry.journal.retire(claim.ownershipId)) return false;
        try { return releaseActiveClaim(registry, claim); } catch { return false; }
      },
    },
  );
  claim.stopLinuxMonitor = stopTrackedMonitor;
  registry.activeLinuxMonitors.add(stopTrackedMonitor);
}

async function admitLinuxGuardian(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  pid: number,
  spawnedAfterMs: number,
): Promise<boolean> {
  const guardianPath = registry.darwinGuardianPath;
  let durableClaim: RuntimeOwnedProcessClaim | null = null;
  try {
    if (!guardianPath || activeRegistry !== registry) {
      throw new Error("The Linux owned process guardian is unavailable.");
    }
    const identity = await readLinuxGuardianReadyWithRetriesAsync(
      pid,
      guardianPath,
      process.pid,
      registry.admissionController.signal,
    );
    if (!identity || activeRegistry !== registry || registry.tainted) {
      throw new Error("The Linux owned process guardian is not ready.");
    }
    claim.linuxIdentity = identity;
    durableClaim = registry.journal.claim(
      claim.ownershipId,
      registry.runtimeGenerationId,
      registry.systemBootId,
      pid,
      process.pid,
      {
        spawnedAfterMs,
        spawnedBeforeMs: Date.now(),
        expectedLinuxIdentity: identity,
      },
    );
    monitorLinuxGuardian(registry, claim, durableClaim);
    let claimed = await signalLinuxGuardianExactAsync(
      identity,
      guardianPath,
      "claim",
      registry.admissionController.signal,
    );
    if (!claimed) {
      const observedClaimed = await readLinuxGuardianClaimedAsync(
        pid,
        guardianPath,
        process.pid,
        registry.admissionController.signal,
      );
      claimed = Boolean(
        observedClaimed
        && RuntimeOwnedProcessJournal.identityMatches(durableClaim, observedClaimed),
      );
    }
    if (!claimed) {
      throw new Error("The Linux owned process guardian could not be claimed.");
    }
    const owned = registry.journal.own(claim.ownershipId);
    if (!owned) {
      throw new Error("The Linux owned process authorization could not be persisted.");
    }
    if (claim.stopRequested || registry.tainted) {
      if (!await signalLinuxGuardianExactAsync(
        identity,
        guardianPath,
        "stop",
        registry.admissionController.signal,
      )) {
        throw new Error("The Linux owned process guardian could not be stopped.");
      }
      return true;
    }
    let authorized = await signalLinuxGuardianExactAsync(
      owned.process as LinuxProcessIdentity,
      guardianPath,
      "exec",
      registry.admissionController.signal,
    );
    if (!authorized) {
      const observedOwned = await readLinuxGuardianOwnedAsync(
        pid,
        guardianPath,
        process.pid,
        registry.admissionController.signal,
      );
      authorized = Boolean(
        observedOwned
        && RuntimeOwnedProcessJournal.identityMatches(owned, observedOwned),
      );
    }
    // A very short payload can advance beyond the transient `owned` marker
    // before the asynchronous exec helper observes it. Only the monitor's
    // exact hardened post-authorization terminal marker is equivalent proof;
    // ordinary cancellation and parent-loss terminals remain unaccepted.
    authorized ||= claim.authorizationObserved;
    if (!authorized) {
      throw new Error("The Linux owned process guardian could not be authorized.");
    }
    if (claim.stopRequested) {
      if (!await signalLinuxGuardianExactAsync(
        identity,
        guardianPath,
        "stop",
        registry.admissionController.signal,
      )) {
        throw new Error("The Linux owned process guardian could not be stopped.");
      }
    }
    return true;
  } catch {
    if (activeRegistry !== registry) return false;
    registry.tainted = true;
    if (guardianPath) {
      if (claim.linuxIdentity) {
        await signalLinuxGuardianExactAsync(
          claim.linuxIdentity,
          guardianPath,
          "stop",
        );
      } else if (pid > 1) {
        // A readiness probe can fail before it publishes a birth identity.
        // Stop only the still-direct, exact helper executable in its hardened
        // pre-claim state; this path can never claim or authorize a payload.
        await stopPendingLinuxGuardianAsync(
          pid,
          guardianPath,
          process.pid,
        );
      }
    }
    const record = registry.journal.records(registry.runtimeGenerationId)
      ?.find((candidate) => candidate.ownershipId === claim.ownershipId);
    if ((!record || record.state === "pending" || record.state === "preauth") && pid > 1) {
      const processCanExecute = failedClaimProcessCanExecute(
        registry.platform,
        guardianPath,
        PROCESS_GROUP_EXIT_WAIT_MS,
      );
      if (processCanExecute) {
        void releaseFailedPidClaimIfStopped(
          registry,
          claim,
          pid,
          processCanExecute,
        );
      }
    }
    return false;
  }
}

function trackAdmission(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  admission: Promise<boolean>,
): void {
  claim.admission = admission;
  registry.pendingAdmissions.add(admission);
  void admission.then((admitted) => { claim.admissionSucceeded = admitted; });
  void admission.finally(() => {
    registry.pendingAdmissions.delete(admission);
    if (claim.admission === admission) claim.admission = null;
  });
}

function settleNormallyClosedDarwinGuardian(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
): void {
  // The admitted native guardian can exit normally only before releasing its
  // payload gate or after its bounded owned-tree drain succeeds. Unproved
  // containment terminates the guardian by signal and never reaches here.
  const settle = (admitted: boolean): void => {
    if (!admitted || activeRegistry !== registry || claim.released) return;
    try { releaseActiveClaim(registry, claim); } catch {
      // The durable claim remains authoritative when retirement cannot persist.
    }
  };
  const admission = claim.admission;
  if (admission) void admission.then(settle);
  else settle(claim.admissionSucceeded);
}

function settleClosedLinuxGuardian(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  pid: number,
): void {
  const settle = (): void => {
    if (claim.released || activeRegistry !== registry) return;
    const record = registry.journal.records(registry.runtimeGenerationId)
      ?.find((candidate) => candidate.ownershipId === claim.ownershipId);
    if (record?.state === "owned" || record?.state === "retiring") {
      if (!registry.journal.retire(claim.ownershipId)) return;
      void releaseIfGroupExited(registry, claim, pid);
      return;
    }
    if (record?.state === "pending" || record?.state === "preauth") {
      const processCanExecute = failedClaimProcessCanExecute(
        registry.platform,
        registry.darwinGuardianPath,
        PROCESS_GROUP_EXIT_WAIT_MS,
      );
      if (processCanExecute) {
        void releaseFailedPidClaimIfStopped(
          registry,
          claim,
          pid,
          processCanExecute,
        );
      }
    }
  };
  const admission = claim.admission;
  if (admission) void admission.then(settle);
  else settle();
}

async function admitDarwinGuardian(
  registry: ActiveRuntimeOwnedProcessRegistry,
  claim: ActiveRuntimeOwnedProcessClaim,
  child: Pick<ChildProcess, "pid" | "kill">,
  spawnedAfterMs: number,
): Promise<boolean> {
  const guardianPath = registry.darwinGuardianPath;
  const pid = child.pid ?? 0;
  let readyIdentity: DarwinProcessIdentity | null = null;
  try {
    if (!guardianPath || activeRegistry !== registry) {
      throw new Error("The macOS owned process guardian is unavailable.");
    }
    readyIdentity = await registry.readDarwinGuardianReadyAsync(
      pid,
      registry.admissionController.signal,
    );
    if (!readyIdentity || activeRegistry !== registry || registry.tainted) {
      throw new Error("The macOS owned process guardian is not ready.");
    }
    // The hardened readiness helper reads and returns the exact guardian birth
    // identity only after PID=PGID=SID and every cleanup/authorization handler
    // is installed. Persist that observation directly; a second helper here
    // added no security boundary and doubled the pre-claim probe cost.
    claim.darwinIdentity = readyIdentity;
    const durableClaim = registry.journal.claim(
      claim.ownershipId,
      registry.runtimeGenerationId,
      registry.systemBootId,
      pid,
      process.pid,
      {
        spawnedAfterMs,
        spawnedBeforeMs: Date.now(),
        expectedDarwinIdentity: readyIdentity,
        observedDarwinIdentity: readyIdentity,
      },
    );
    // Keep the distinct post-persistence check immediately before SIGUSR1.
    // This is the authorization boundary that detects PID reuse or identity
    // change after the durable claim has been written.
    const authorizationIdentity = await registry.readDarwinIdentityAsync(
      pid,
      registry.admissionController.signal,
    );
    if (
      !authorizationIdentity
      || !RuntimeOwnedProcessJournal.identityMatches(
        durableClaim,
        authorizationIdentity,
      )
    ) throw new Error("The macOS owned process guardian identity changed.");
    claim.darwinIdentity = authorizationIdentity;
    if (claim.stopRequested || registry.tainted) {
      child.kill("SIGTERM");
      return true;
    }
    process.kill(authorizationIdentity.pid, "SIGUSR1");
    return true;
  } catch {
    if (activeRegistry !== registry) return false;
    registry.tainted = true;
    await hardStopUnclaimedDarwinGuardian(
      child,
      registry,
      claim.darwinIdentity ?? readyIdentity,
    );
    const processCanExecute = failedClaimProcessCanExecute(
      registry.platform,
      guardianPath,
      PROCESS_GROUP_EXIT_WAIT_MS,
    );
    if (processCanExecute && pid > 1) {
      void releaseFailedPidClaimIfStopped(
        registry,
        claim,
        pid,
        processCanExecute,
      );
    }
    return false;
  }
}

export function spawnRuntimeOwnedProcess<T extends ChildProcess>(
  spawnProcess: () => T,
): T {
  const registry = activeRegistry;
  if (!registry) return spawnProcess();
  if (registry.tainted) throw new Error("Runtime process ownership is tainted until restart.");
  const ownershipId = registry.journal.begin(
    registry.runtimeGenerationId,
    registry.systemBootId,
  );
  const spawnedAfterMs = Date.now();
  let child: T;
  try {
    child = spawnProcess();
    if (
      (registry.platform === "darwin" || registry.platform === "linux")
      && child.spawnfile !== registry.darwinGuardianPath
    ) throw new Error("The macOS owned process did not use its guardian.");
  } catch (error) {
    registry.journal.release(ownershipId);
    throw error;
  }
  const claim: ActiveRuntimeOwnedProcessClaim = {
    ownershipId,
    released: false,
    stopRequested: false,
    authorizationObserved: false,
    admissionSucceeded: false,
    groupExitReleaseAttempts: 0,
    admission: null,
    releaseConfirmation: null,
    settleReleaseConfirmation: null,
  };
  if (registry.platform === "linux") {
    registry.claims.set(child, claim);
    child.once("close", (_code, signal) => {
      if (typeof signal === "string") {
        registry.tainted = true;
        return;
      }
      settleClosedLinuxGuardian(registry, claim, child.pid ?? 0);
    });
    const admission = admitLinuxGuardian(
      registry,
      claim,
      child.pid ?? 0,
      spawnedAfterMs,
    );
    trackAdmission(registry, claim, admission);
    return child;
  }
  if (registry.platform === "darwin") {
    registry.claims.set(child, claim);
    child.once("close", (code, signal) => {
      // Guardian-level signals are the fail-closed containment marker.
      if (typeof code !== "number" || signal !== null) {
        registry.tainted = true;
        return;
      }
      settleNormallyClosedDarwinGuardian(registry, claim);
    });
    const admission = admitDarwinGuardian(registry, claim, child, spawnedAfterMs);
    trackAdmission(registry, claim, admission);
    return child;
  }
  try {
    const durableClaim = registry.journal.claim(
      ownershipId,
      registry.runtimeGenerationId,
      registry.systemBootId,
      child.pid ?? 0,
      process.pid,
      {
        spawnedAfterMs,
        spawnedBeforeMs: Date.now(),
      },
    );
    monitorLinuxGuardian(registry, claim, durableClaim);
    registry.claims.set(child, claim);
    child.once("close", (_code, _signal) => {
      // The guardian handles normal stop signals itself and reports payload
      // signals as numeric exit statuses. A signal on the guardian process is
      // therefore an unambiguous unproved-containment marker (or an external
      // hard kill); retain the durable claim for explicit recovery.
      if (registry.platform === "win32") {
        try { releaseActiveClaim(registry, claim); } catch {
          // The durable claim remains for startup recovery.
        }
      } else {
        void releaseIfGroupExited(registry, claim, child.pid ?? 0);
      }
    });
  } catch (error) {
    if (child.pid === undefined) registry.journal.release(ownershipId);
    else {
      hardStopUnclaimed(child, registry.platform);
      const processCanExecute = failedClaimProcessCanExecute(
        registry.platform, registry.darwinGuardianPath, PROCESS_GROUP_EXIT_WAIT_MS,
      );
      if (processCanExecute) {
        void releaseFailedPidClaimIfStopped(
          registry,
          claim,
          child.pid,
          processCanExecute,
        );
      }
    }
    throw error;
  }
  return child;
}

export interface RuntimeOwnedPidProcess<T> {
  readonly process: T;
  confirmStopped(): boolean;
  releaseIfGroupExited(exitSignal?: number): void;
  requestPayloadExit?(): boolean;
  requestGuardianStop(): boolean;
  waitForGuardianStop(): Promise<boolean>;
}

export function spawnRuntimeOwnedPidProcess<T extends { readonly pid: number }>(
  spawnProcess: () => T,
  options: RuntimeOwnedPidProcessOptions = {},
): RuntimeOwnedPidProcess<T> {
  const registry = activeRegistry;
  if (!registry) {
    return {
      process: spawnProcess(),
      confirmStopped: () => true,
      releaseIfGroupExited: () => undefined,
      requestPayloadExit: () => false,
      requestGuardianStop: () => false,
      waitForGuardianStop: async () => false,
    };
  }
  if (registry.tainted) throw new Error("Runtime process ownership is tainted until restart.");
  const ownershipId = registry.journal.begin(
    registry.runtimeGenerationId,
    registry.systemBootId,
  );
  const claim: ActiveRuntimeOwnedProcessClaim = {
    ownershipId,
    released: false,
    stopRequested: false,
    authorizationObserved: false,
    admissionSucceeded: false,
    groupExitReleaseAttempts: 0,
    admission: null,
    releaseConfirmation: null,
    settleReleaseConfirmation: null,
  };
  let owned: T | null = null;
  const spawnedAfterMs = Date.now();
  try {
    owned = spawnProcess();
    if (
      (registry.platform === "darwin" || registry.platform === "linux")
      && options.darwinGuardianCommand !== registry.darwinGuardianPath
    ) throw new Error("The owned process did not use its platform guardian.");
    if (registry.platform === "linux") {
      const confirmedOwned = owned;
      const admission = admitLinuxGuardian(
        registry,
        claim,
        owned.pid,
        spawnedAfterMs,
      );
      trackAdmission(registry, claim, admission);
      let stopBarrier = admission;
      return {
        process: confirmedOwned,
        confirmStopped: () => claim.released,
        requestPayloadExit: () => false,
        requestGuardianStop: () => {
          if (claim.released) return true;
          claim.stopRequested = true;
          if (!claim.admission && claim.linuxIdentity && registry.darwinGuardianPath) {
            stopBarrier = signalLinuxGuardianExactAsync(
              claim.linuxIdentity,
              registry.darwinGuardianPath,
              "stop",
            );
          }
          return true;
        },
        waitForGuardianStop: async () => await stopBarrier,
        releaseIfGroupExited: (exitSignal) => {
          if (typeof exitSignal === "number" && exitSignal > 0) {
            registry.tainted = true;
            return;
          }
          settleClosedLinuxGuardian(registry, claim, confirmedOwned.pid);
        },
      };
    } else if (registry.platform === "darwin") {
      const confirmedOwned = owned;
      const guardian = {
        pid: confirmedOwned.pid,
        kill: (signal: NodeJS.Signals) => {
          process.kill(confirmedOwned.pid, signal);
          return true;
        },
      };
      const admission = admitDarwinGuardian(
        registry,
        claim,
        guardian,
        spawnedAfterMs,
      );
      trackAdmission(registry, claim, admission);
      return {
        process: confirmedOwned,
        // Only a normal guardian close may retire an admitted live claim.
        confirmStopped: () => claim.released,
        requestPayloadExit: () => {
          if (claim.released) return true;
          if (activeRegistry !== registry || registry.tainted
            || !claim.admissionSucceeded || !claim.darwinIdentity) return false;
          try {
            const current = registry.readDarwinIdentity(confirmedOwned.pid);
            if (!current || !sameProcess(current, claim.darwinIdentity)) return false;
            process.kill(current.pid, "SIGUSR2");
            return true;
          } catch {
            return false;
          }
        },
        requestGuardianStop: () => {
          if (claim.released) return true;
          claim.stopRequested = true;
          if (!claim.admission && claim.darwinIdentity) {
            try { process.kill(confirmedOwned.pid, "SIGTERM"); } catch {
              // The durable claim remains authoritative when the guardian is gone.
            }
          }
          return true;
        },
        waitForGuardianStop: async () => await admission,
        releaseIfGroupExited: (exitSignal) => {
          if (exitSignal !== 0) {
            registry.tainted = true;
            return;
          }
          settleNormallyClosedDarwinGuardian(registry, claim);
        },
      };
    } else {
      const durableClaim = registry.journal.claim(
        ownershipId,
        registry.runtimeGenerationId,
        registry.systemBootId,
        owned.pid,
        process.pid,
        {
          spawnedAfterMs,
          spawnedBeforeMs: Date.now(),
        },
      );
      void durableClaim;
    }
  } catch (error) {
    if (registry.platform === "linux") registry.tainted = true;
    if (owned) {
      const failedOwned = owned;
      const unclaimed = {
        pid: failedOwned.pid,
        kill: () => {
          try { process.kill(failedOwned.pid, "SIGKILL"); } catch { /* Gone. */ }
          return true;
        },
      };
      if (registry.platform === "linux" && registry.darwinGuardianPath) {
        const record = registry.journal.records(registry.runtimeGenerationId)
          ?.find((candidate) => candidate.ownershipId === ownershipId);
        if (record && record.state !== "pending" && "startTimeTicks" in record.process) {
          void signalLinuxGuardianExact(record.process, registry.darwinGuardianPath, "stop");
        }
      } else hardStopUnclaimed(unclaimed, registry.platform);
      const processCanExecute = failedClaimProcessCanExecute(
        registry.platform, registry.darwinGuardianPath, PROCESS_GROUP_EXIT_WAIT_MS,
      );
      if (processCanExecute) {
        void releaseFailedPidClaimIfStopped(
          registry,
          claim,
          failedOwned.pid,
          options.processCanExecute ?? processCanExecute,
        );
      }
    } else registry.journal.release(ownershipId);
    throw error;
  }
  const confirmedOwned = owned;
  return {
    process: confirmedOwned,
    confirmStopped: () => registry.platform === "linux"
      ? claim.released
      : releaseActiveClaim(registry, claim),
    requestPayloadExit: () => false,
    requestGuardianStop: () => {
      if (registry.platform !== "linux" && registry.platform !== "darwin") return false;
      if (claim.released) return true;
      if (registry.platform === "linux") {
        if (claim.linuxIdentity && registry.darwinGuardianPath) {
          signalLinuxGuardianExact(
            claim.linuxIdentity,
            registry.darwinGuardianPath,
            "stop",
          );
        }
        // Consume the guarded request even when the exact helper cannot act;
        // the caller must not fall back to signalling a recyclable PID/PGID.
        return true;
      }
      try { process.kill(confirmedOwned.pid, "SIGTERM"); return true; } catch { return false; }
    },
    waitForGuardianStop: async () => false,
    releaseIfGroupExited: (exitSignal) => {
      if (registry.platform === "win32") {
        try { releaseActiveClaim(registry, claim); } catch {
          // The durable claim remains for startup recovery.
        }
      } else if (
        (registry.platform === "darwin" || registry.platform === "linux")
        && typeof exitSignal === "number"
        && exitSignal > 0
      ) {
        // A guardian-level signal is the unproved-containment marker. Do not
        // let a now-empty private session erase evidence of a detached child.
        if (registry.platform === "linux") registry.tainted = true;
        return;
      } else {
        void releaseIfGroupExited(registry, claim, confirmedOwned.pid);
      }
    },
  };
}

export function confirmRuntimeOwnedProcessStopped(child: ChildProcess): boolean {
  const registry = activeRegistry;
  const claim = registry?.claims.get(child);
  return registry && claim
    ? (registry.platform === "linux"
        ? claim.released
        : registry.platform === "darwin"
          ? claim.released
          : releaseActiveClaim(registry, claim))
    : true;
}

export function runtimeOwnedProcessCleanupConfirmed(): boolean {
  if (!activeRegistry) {
    return !supportedRuntimeOwnedProcessPlatform(process.platform);
  }
  const records = activeRegistry.journal.records(
    activeRegistry.runtimeGenerationId,
  );
  return activeRegistry.pendingAdmissions.size === 0
    && records !== null
    && records.length === 0;
}

export function runtimeOwnedProcessOwnershipIsTainted(): boolean {
  return activeRegistry?.tainted ?? false;
}

export async function awaitRuntimeOwnedProcessCleanupConfirmed(): Promise<boolean> {
  const registry = activeRegistry;
  if (!registry) return !supportedRuntimeOwnedProcessPlatform(process.platform);
  while (activeRegistry === registry) {
    const closing = [
      ...registry.pendingAdmissions,
      ...registry.pendingReleaseConfirmations,
    ];
    if (closing.length === 0) break;
    await Promise.all(closing);
  }
  if (activeRegistry !== registry) return false;
  return runtimeOwnedProcessCleanupConfirmed();
}
