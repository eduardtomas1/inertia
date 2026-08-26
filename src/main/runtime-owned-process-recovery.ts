import {
  type ObservedRuntimeOwnedProcessIdentity,
  readDarwinProcessIdentity,
  readLinuxProcessIdentity,
  RuntimeOwnedProcessJournal,
  type RuntimeOwnedDarwinProcessPending,
  type RuntimeOwnedProcessClaim,
  type RuntimeOwnedProcessPlatform,
  supportedRuntimeOwnedProcessPlatform,
} from "../node/runtime-owned-processes.js";
import { forceKillRuntimeProcessTree } from "./runtime-process-tree.js";
import { RuntimeCleanupReceiptJournal } from "./runtime-cleanup-receipts.js";
import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import { recoverWindowsRuntimeJob } from "./windows-runtime-job.js";
export { readDarwinProcessIdentity } from "../node/runtime-owned-processes.js";

type Kill = (pid: number, signal?: NodeJS.Signals | number) => true;
const DARWIN_PENDING_WATCHDOG_DRAIN_MS = 200;
const PROCESS_GROUP_DRAIN_POLL_MS = 20;
const PROCESS_GROUP_DRAIN_POLLS = 50;

export interface RuntimeOwnedProcessRecoveryOptions {
  readonly deadlineAt: number;
  readonly platform?: NodeJS.Platform;
  readonly kill?: Kill;
  readonly forceKill?: typeof forceKillRuntimeProcessTree;
  readonly readIdentity?: (
    pid: number,
  ) => ObservedRuntimeOwnedProcessIdentity | null;
  readonly recoverWindowsJob?: typeof recoverWindowsRuntimeJob;
  readonly darwinGuardianPath?: string;
  readonly waitForProcessGroupDrain?: (durationMs: number) => Promise<void>;
}

function exactPidAbsent(pid: number, kill: Kill): boolean {
  try {
    kill(pid, 0);
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

function guardedDarwinPending(
  record: { readonly state: "pending" },
): record is RuntimeOwnedDarwinProcessPending {
  return "containment" in record
    && record.containment === "darwin-parent-watchdog-v1"
    && "runtimeParentPid" in record
    && Number.isSafeInteger(record.runtimeParentPid)
    && Number(record.runtimeParentPid) > 1;
}

function readProcessIdentity(
  pid: number,
  platform: RuntimeOwnedProcessPlatform,
  deadlineAt: number,
  darwinGuardianPath?: string,
): ObservedRuntimeOwnedProcessIdentity | null {
  if (platform === "linux") return readLinuxProcessIdentity(pid);
  if (platform === "darwin") {
    if (!darwinGuardianPath) {
      throw new Error("The macOS runtime process guardian is unavailable.");
    }
    return readDarwinProcessIdentity(pid, darwinGuardianPath, { deadlineAt });
  }
  return null;
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

function missingRootProcessGroupAbsent(
  claim: RuntimeOwnedProcessClaim,
  kill: Kill,
): boolean {
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

async function waitForMissingRootCleanup(
  claim: RuntimeOwnedProcessClaim,
  platform: RuntimeOwnedProcessPlatform,
  kill: Kill,
  deadlineAt: number,
  wait: (durationMs: number) => Promise<void>,
): Promise<boolean> {
  // Windows recovery never reaches this identity path: the named Job Object
  // is the sole authority. A missing POSIX root is never signalled; its claim
  // can be retired only after the already-claimed process group is absent.
  if (platform !== "darwin" && platform !== "linux") return false;
  if (missingRootProcessGroupAbsent(claim, kill)) return true;
  for (let poll = 0; poll < PROCESS_GROUP_DRAIN_POLLS; poll += 1) {
    if (Date.now() + PROCESS_GROUP_DRAIN_POLL_MS >= deadlineAt) return false;
    await wait(PROCESS_GROUP_DRAIN_POLL_MS);
    if (missingRootProcessGroupAbsent(claim, kill)) return true;
  }
  return false;
}

/**
 * Recovers one durable generation without guessing process ownership.
 *
 * A legacy pending claim stays fail-closed. A macOS intent admitted behind the
 * native parent watchdog can be retired only after the exact runtime parent is
 * absent across the watchdog's bounded drain. Owned claims are killed only
 * while their platform-specific birth identity still matches. Reused roots
 * stay fail-closed and are never signalled. Windows uses its named Job Object;
 * a missing Linux or macOS root is retired only after the exact claimed group
 * is proven absent, and an extant group remains fail-closed.
 */
export function recoverRuntimeOwnedProcesses(
  dataDirectory: string,
  runtimeGenerationId: string,
  systemBootId: string,
  options: RuntimeOwnedProcessRecoveryOptions,
): boolean | Promise<boolean> | null {
  const platform = options.platform ?? process.platform;
  if (!supportedRuntimeOwnedProcessPlatform(platform)) return null;
  const journal = new RuntimeOwnedProcessJournal(dataDirectory, {
    platform,
    ...(options.darwinGuardianPath
      ? { darwinGuardianPath: options.darwinGuardianPath }
      : {}),
  });
  const records = journal.records(runtimeGenerationId);
  if (!records) return null;
  if (platform === "win32") {
    const containment = journal.containment(runtimeGenerationId);
    if (containment === undefined) return null;
    if (!containment) return records.length === 0 ? true : Promise.resolve(false);
    return (async () => {
      const recovered = await (options.recoverWindowsJob
        ?? recoverWindowsRuntimeJob)(containment, options.deadlineAt);
      if (!recovered) return false;
      for (const record of records) {
        if (!journal.release(record.ownershipId)) return false;
      }
      return true;
    })();
  }
  if (records.length === 0) return true;
  return (async () => {
    const kill = options.kill ?? process.kill;
    const waitForProcessGroupDrain = options.waitForProcessGroupDrain
      ?? ((durationMs: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
      }));
    const pending = records.filter((record) => record.state === "pending");
    if (pending.length > 0) {
      const guardedPending = pending.filter(guardedDarwinPending);
      if (
        platform !== "darwin"
        || guardedPending.length !== pending.length
        || guardedPending.some((record) =>
          !exactPidAbsent(record.runtimeParentPid, kill))
        || Date.now() + DARWIN_PENDING_WATCHDOG_DRAIN_MS >= options.deadlineAt
      ) return false;
      await waitForProcessGroupDrain(DARWIN_PENDING_WATCHDOG_DRAIN_MS);
      if (guardedPending.some((record) =>
        !exactPidAbsent(record.runtimeParentPid, kill))) return false;
      for (const record of guardedPending) {
        if (!journal.release(record.ownershipId)) return false;
      }
    }
    const forceKill = options.forceKill ?? forceKillRuntimeProcessTree;
    const readIdentity = options.readIdentity
      ?? ((pid: number) => readProcessIdentity(
        pid,
        platform,
        options.deadlineAt,
        options.darwinGuardianPath,
      ));
    for (const record of records) {
      if (record.state !== "owned") continue;
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
          !await waitForMissingRootCleanup(
            record,
            platform,
            kill,
            options.deadlineAt,
            waitForProcessGroupDrain,
          )
          || !journal.release(record.ownershipId)
        ) return false;
        continue;
      }
      if (!RuntimeOwnedProcessJournal.identityMatches(record, identity)) return false;
      if (
        identity.processGroupId !== identity.pid
        || Date.now() >= options.deadlineAt
      ) return false;
      const confirmed = await forceKill(identity.pid, {
        rootProcessGroup: true,
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
  darwinGuardianPath?: string;
}): Promise<boolean> | null {
  const platform = options.platform ?? process.platform;
  if (!supportedRuntimeOwnedProcessPlatform(platform)) return null;
  options.leases.refresh();
  const prior = options.leases.all().filter((lease) =>
    lease.systemBootId === options.systemBootId);
  if (prior.length === 0) return null;
  const journal = new RuntimeOwnedProcessJournal(options.dataDirectory, {
    platform,
    ...(options.darwinGuardianPath
      ? { darwinGuardianPath: options.darwinGuardianPath }
      : {}),
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
        {
          deadlineAt: options.deadlineAt,
          platform,
          ...(options.darwinGuardianPath
            ? { darwinGuardianPath: options.darwinGuardianPath }
            : {}),
        },
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
