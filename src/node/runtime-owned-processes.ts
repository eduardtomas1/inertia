import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  darwinProcessGuardianReady,
  darwinProcessSessionEmpty,
  readDarwinProcessIdentity,
  type DarwinProcessIdentity,
} from "./runtime-owned-process-darwin.js";
import {
  exactProcessGroupAbsent,
  failedClaimProcessCanExecute,
} from "./runtime-owned-process-posix.js";
import {
  monitorLinuxGuardianTerminal,
  readLinuxGuardianClaimed,
  signalLinuxGuardianExact,
} from "./runtime-owned-process-linux.js";
import {
  RuntimeOwnedProcessJournal,
  readLinuxProcessIdentity,
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
  darwinProcessSessionEmpty,
  readDarwinProcessIdentity,
} from "./runtime-owned-process-darwin.js";
export type { DarwinProcessIdentity } from "./runtime-owned-process-darwin.js";

const PROCESS_GROUP_EXIT_WAIT_MS = 1_000;
const PROCESS_GROUP_EXIT_POLL_MS = 10;
const PID_PROCESS_GROUP_SETTLE_WAIT_MS = 100;
const PID_PROCESS_GROUP_SETTLE_POLL_MS = 1;
const PID_PROCESS_GROUP_SETTLE_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
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
  readonly claims: WeakMap<ChildProcess, ActiveRuntimeOwnedProcessClaim>;
  readonly pendingReleaseConfirmations: Set<Promise<boolean>>;
  tainted: boolean;
}

interface ActiveRuntimeOwnedProcessClaim {
  readonly ownershipId: string;
  released: boolean;
  releaseConfirmation: Promise<boolean> | null;
  settleReleaseConfirmation: ((confirmed: boolean) => void) | null;
  linuxIdentity?: LinuxProcessIdentity;
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
    claims: new WeakMap(),
    pendingReleaseConfirmations: new Set(),
    tainted: false,
  };
  activeRegistry = registry;
  return () => {
    if (activeRegistry === registry) activeRegistry = null;
  };
}

export interface RuntimeOwnedProcessInvocation {
  readonly command: string;
  readonly args: string[];
}

/**
 * Places every macOS runtime child inside the native guardian's private
 * process session. The helper execs the requested program without a shell;
 * the guardian stays alive until every process in that session is drained.
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

/** Requests the platform guardian to drain an exact actively-owned child. */
export function requestRuntimeOwnedGuardianStop(child: ChildProcess): boolean {
  const registry = activeRegistry;
  if (!registry || (registry.platform !== "darwin" && registry.platform !== "linux")) {
    return false;
  }
  const claim = registry.claims.get(child);
  if (!claim || claim.released || !child.pid) return false;
  if (registry.platform === "linux") {
    return Boolean(
      claim.linuxIdentity
      && registry.darwinGuardianPath
      && signalLinuxGuardianExact(
        claim.linuxIdentity,
        registry.darwinGuardianPath,
        "stop",
      ),
    );
  }
  try {
    return child.kill("SIGTERM");
  } catch {
    return false;
  }
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

function hardStopUnclaimedDarwinGuardian(
  child: Pick<ChildProcess, "pid" | "kill">,
  registry: ActiveRuntimeOwnedProcessRegistry,
  expectedIdentity: DarwinProcessIdentity | null,
): void {
  const pid = child.pid;
  if (!pid || !expectedIdentity || !registry.darwinGuardianPath) return;
  let current: DarwinProcessIdentity | null = null;
  try {
    current = registry.readDarwinIdentity(pid);
  } catch {
    return;
  }
  if (!current || !sameProcess(expectedIdentity, current)) return;
  try { child.kill("SIGKILL"); } catch { /* The exact guardian may be gone. */ }
}

function exactPendingClaim(
  registry: ActiveRuntimeOwnedProcessRegistry,
  ownershipId: string,
): boolean {
  const records = registry.journal.records(registry.runtimeGenerationId);
  if (!records) return false;
  const matching = records.filter((record) =>
    record.ownershipId === ownershipId);
  return matching.length === 1
    && matching[0]?.state === "pending"
    && matching[0].runtimeGenerationId === registry.runtimeGenerationId
    && matching[0].systemBootId === registry.systemBootId;
}

function defaultSettleWait(durationMs: number): void {
  Atomics.wait(
    PID_PROCESS_GROUP_SETTLE_SIGNAL,
    0,
    0,
    durationMs,
  );
}

interface RuntimeOwnedPidProcessOptions {
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => void;
  readonly readIdentity?: (pid: number) => LinuxProcessIdentity | null;
  readonly processCanExecute?: (pid: number) => boolean | null;
  readonly darwinGuardianCommand?: string;
}

function claimPidProcessAfterGroupSettle(
  registry: ActiveRuntimeOwnedProcessRegistry,
  ownershipId: string,
  pid: number,
  options: RuntimeOwnedPidProcessOptions,
): RuntimeOwnedProcessClaim {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultSettleWait;
  const readIdentity = options.readIdentity ?? readLinuxProcessIdentity;
  const deadlineAt = now() + PID_PROCESS_GROUP_SETTLE_WAIT_MS;
  while (true) {
    if (!exactPendingClaim(registry, ownershipId)) {
      throw new Error("The spawned process ownership intent changed.");
    }
    const identity = readIdentity(pid);
    if (
      !identity
      || identity.pid !== pid
      || identity.parentPid !== process.pid
    ) throw new Error("The spawned process identity could not be proven.");
    if (identity.processGroupId === pid) {
      try {
        return registry.journal.claim(
          ownershipId,
          registry.runtimeGenerationId,
          registry.systemBootId,
          pid,
          process.pid,
        );
      } catch (error) {
        if (!exactPendingClaim(registry, ownershipId)) throw error;
        const current = readIdentity(pid);
        if (
          !current
          || current.pid !== pid
          || current.parentPid !== process.pid
          || current.processGroupId === pid
        ) throw error;
      }
    }
    const remainingMs = Math.trunc(deadlineAt - now());
    if (remainingMs <= 0) {
      throw new Error("The spawned process group identity did not settle.");
    }
    wait(Math.max(
      1,
      Math.min(PID_PROCESS_GROUP_SETTLE_POLL_MS, remainingMs),
    ));
  }
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
      || !exactPendingClaim(registry, claim.ownershipId)
    ) {
      settleConfirmation(claim.released);
      return;
    }
    const executable = processCanExecute(pid);
    if (executable === false && exactProcessGroupAbsent(pid) === true) {
      try {
        settleConfirmation(releaseActiveClaim(registry, claim));
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
  claim.releaseConfirmation = confirmation;
  claim.settleReleaseConfirmation = settleConfirmation;
  registry.pendingReleaseConfirmations.add(confirmation);
  void confirmation.then(() => {
    registry.pendingReleaseConfirmations.delete(confirmation);
    claim.settleReleaseConfirmation = null;
  });
  const deadlineAt = Date.now() + PROCESS_GROUP_EXIT_WAIT_MS;
  const poll = (): void => {
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
        ? Boolean(
            registry.darwinGuardianPath
            && darwinProcessSessionEmpty(pid, registry.darwinGuardianPath),
          )
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
      poll,
      Math.max(1, Math.min(PROCESS_GROUP_EXIT_POLL_MS, remainingMs)),
    );
    timer.unref();
  };
  poll();
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
  claim.stopLinuxMonitor = monitorLinuxGuardianTerminal(
    durableClaim.process,
    registry.darwinGuardianPath,
    () => registry.journal.retire(claim.ownershipId),
    () => { registry.tainted = true; },
  );
}

function authorizeGuardian(
  registry: ActiveRuntimeOwnedProcessRegistry,
  durableClaim: RuntimeOwnedProcessClaim,
): void {
  if (registry.platform === "linux") {
    if (!("startTimeTicks" in durableClaim.process)
      || !registry.darwinGuardianPath
      || !signalLinuxGuardianExact(durableClaim.process, registry.darwinGuardianPath, "claim")) {
      throw new Error("The Linux owned process guardian could not be claimed.");
    }
    const claimed = registry.darwinGuardianPath
      ? readLinuxGuardianClaimed(
          durableClaim.process.pid,
          registry.darwinGuardianPath,
          process.pid,
        )
      : null;
    if (!claimed || !RuntimeOwnedProcessJournal.identityMatches(durableClaim, claimed)) {
      throw new Error("The Linux owned process guardian did not enter claimed state.");
    }
    const owned = registry.journal.own(durableClaim.ownershipId);
    if (!owned) throw new Error("The Linux owned process authorization could not be persisted.");
    if (!("startTimeTicks" in owned.process)
      || !signalLinuxGuardianExact(owned.process, registry.darwinGuardianPath, "exec")) {
      throw new Error("The Linux owned process guardian could not be authorized.");
    }
    return;
  }
  if (registry.platform !== "darwin") return;
  if (
    !("platform" in durableClaim.process)
    || durableClaim.process.platform !== "darwin"
    || !registry.darwinGuardianPath
  ) throw new Error("The macOS owned process guardian is invalid.");
  const identity = registry.readDarwinIdentity(durableClaim.process.pid);
  if (
    !identity
    || !RuntimeOwnedProcessJournal.identityMatches(durableClaim, identity)
  ) throw new Error("The macOS owned process guardian identity changed.");
  process.kill(identity.pid, "SIGUSR1");
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
    releaseConfirmation: null,
    settleReleaseConfirmation: null,
  };
  let darwinGuardianIdentity: DarwinProcessIdentity | null = null;
  try {
    if (registry.platform === "darwin" && registry.darwinGuardianPath) {
      darwinGuardianIdentity = registry.readDarwinGuardianReady(child.pid ?? 0);
      if (!darwinGuardianIdentity) {
        throw new Error("The macOS owned process guardian is not ready.");
      }
    }
    const durableClaim = registry.journal.claim(
      ownershipId,
      registry.runtimeGenerationId,
      registry.systemBootId,
      child.pid ?? 0,
      process.pid,
      {
        spawnedAfterMs,
        spawnedBeforeMs: Date.now(),
        ...(darwinGuardianIdentity
          ? { expectedDarwinIdentity: darwinGuardianIdentity }
          : {}),
      },
    );
    monitorLinuxGuardian(registry, claim, durableClaim);
    authorizeGuardian(registry, durableClaim);
    registry.claims.set(child, claim);
    child.once("close", (_code, signal) => {
      // The guardian handles normal stop signals itself and reports payload
      // signals as numeric exit statuses. A signal on the guardian process is
      // therefore an unambiguous unproved-containment marker (or an external
      // hard kill); retain the durable claim for explicit recovery.
      if (
        (registry.platform === "darwin" || registry.platform === "linux")
        && typeof signal === "string"
      ) {
        if (registry.platform === "linux") registry.tainted = true;
        return;
      }
      if (registry.platform === "win32") {
        try { releaseActiveClaim(registry, claim); } catch {
          // The durable claim remains for startup recovery.
        }
      } else {
        void releaseIfGroupExited(registry, claim, child.pid ?? 0);
      }
    });
  } catch (error) {
    if (registry.platform === "linux") registry.tainted = true;
    if (child.pid === undefined) registry.journal.release(ownershipId);
    else {
      if (registry.platform === "linux" && registry.darwinGuardianPath) {
        const record = registry.journal.records(registry.runtimeGenerationId)
          ?.find((candidate) => candidate.ownershipId === ownershipId);
        if (record && record.state !== "pending" && "startTimeTicks" in record.process) {
          void signalLinuxGuardianExact(record.process, registry.darwinGuardianPath, "stop");
        }
      } else if (registry.platform === "darwin") {
        hardStopUnclaimedDarwinGuardian(
          child,
          registry,
          darwinGuardianIdentity,
        );
      } else hardStopUnclaimed(child, registry.platform);
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
  requestGuardianStop(): boolean;
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
      requestGuardianStop: () => false,
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
    releaseConfirmation: null,
    settleReleaseConfirmation: null,
  };
  let owned: T | null = null;
  let darwinGuardianIdentity: DarwinProcessIdentity | null = null;
  const spawnedAfterMs = Date.now();
  try {
    owned = spawnProcess();
    if (
      (registry.platform === "darwin" || registry.platform === "linux")
      && options.darwinGuardianCommand !== registry.darwinGuardianPath
    ) throw new Error("The owned process did not use its platform guardian.");
    if (registry.platform === "linux") {
      const durableClaim = claimPidProcessAfterGroupSettle(
        registry,
        ownershipId,
        owned.pid,
        options,
      );
      monitorLinuxGuardian(registry, claim, durableClaim);
      authorizeGuardian(registry, durableClaim);
    } else {
      if (registry.platform === "darwin" && registry.darwinGuardianPath) {
        darwinGuardianIdentity = registry.readDarwinGuardianReady(owned.pid);
        if (!darwinGuardianIdentity) {
          throw new Error("The macOS owned process guardian is not ready.");
        }
      }
      const durableClaim = registry.journal.claim(
        ownershipId,
        registry.runtimeGenerationId,
        registry.systemBootId,
        owned.pid,
        process.pid,
        {
          spawnedAfterMs,
          spawnedBeforeMs: Date.now(),
          ...(darwinGuardianIdentity
            ? { expectedDarwinIdentity: darwinGuardianIdentity }
            : {}),
        },
      );
      authorizeGuardian(registry, durableClaim);
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
      } else if (registry.platform === "darwin") {
        hardStopUnclaimedDarwinGuardian(
          unclaimed,
          registry,
          darwinGuardianIdentity,
        );
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
    requestGuardianStop: () => {
      if (registry.platform !== "linux" && registry.platform !== "darwin") return false;
      if (claim.released) return true;
      if (registry.platform === "linux") {
        return Boolean(
          claim.linuxIdentity
          && registry.darwinGuardianPath
          && signalLinuxGuardianExact(
            claim.linuxIdentity,
            registry.darwinGuardianPath,
            "stop",
          ),
        );
      }
      try { process.kill(confirmedOwned.pid, "SIGTERM"); return true; } catch { return false; }
    },
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
    ? (registry.platform === "linux" ? claim.released : releaseActiveClaim(registry, claim))
    : true;
}

export function runtimeOwnedProcessCleanupConfirmed(): boolean {
  if (!activeRegistry) {
    return !supportedRuntimeOwnedProcessPlatform(process.platform);
  }
  const records = activeRegistry.journal.records(
    activeRegistry.runtimeGenerationId,
  );
  return records !== null && records.length === 0;
}

export async function awaitRuntimeOwnedProcessCleanupConfirmed(): Promise<boolean> {
  const registry = activeRegistry;
  if (!registry) return !supportedRuntimeOwnedProcessPlatform(process.platform);
  while (activeRegistry === registry) {
    const closing = [...registry.pendingReleaseConfirmations];
    if (closing.length === 0) break;
    await Promise.all(closing);
  }
  if (activeRegistry !== registry) return false;
  return runtimeOwnedProcessCleanupConfirmed();
}
