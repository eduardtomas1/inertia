import {
  darwinProcessSessionEmpty,
  type ObservedRuntimeOwnedProcessIdentity,
  readDarwinProcessIdentity,
  readLinuxProcessIdentity,
  RuntimeOwnedProcessJournal,
  type RuntimeOwnedDarwinProcessPending,
  type RuntimeOwnedLinuxProcessPending,
  type RuntimeOwnedProcessClaim,
  type RuntimeOwnedProcessPlatform,
  supportedRuntimeOwnedProcessPlatform,
} from "../node/runtime-owned-processes.js";
import { forceKillRuntimeProcessTree } from "./runtime-process-tree.js";
import { RuntimeCleanupReceiptJournal } from "./runtime-cleanup-receipts.js";
import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import {
  recoverWindowsRuntimeJob,
  type WindowsRuntimeJobAssembly,
} from "./windows-runtime-job.js";
import {
  linuxGuardianTerminalAuthority,
  signalLinuxGuardianExact,
} from "../node/runtime-owned-process-linux.js";
export { readDarwinProcessIdentity } from "../node/runtime-owned-processes.js";

type Kill = (pid: number, signal?: NodeJS.Signals | number) => true;
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
  readonly readDarwinSessionEmpty?: (sessionId: number) => boolean;
  readonly recoverWindowsJob?: typeof recoverWindowsRuntimeJob;
  readonly windowsRuntimeJobAssembly?: WindowsRuntimeJobAssembly;
  readonly darwinGuardianPath?: string;
  readonly waitForProcessGroupDrain?: (durationMs: number) => Promise<void>;
  readonly linuxTerminalAuthority?: typeof linuxGuardianTerminalAuthority;
  readonly signalLinuxGuardian?: typeof signalLinuxGuardianExact;
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

function guardedLinuxPending(
  record: { readonly state: "pending" },
): record is RuntimeOwnedLinuxProcessPending {
  return "containment" in record
    && record.containment === "linux-parent-gated-v1"
    && "runtimeParentPid" in record
    && "runtimeParentStartTimeTicks" in record
    && Number.isSafeInteger(record.runtimeParentPid)
    && Number(record.runtimeParentPid) > 1
    && typeof record.runtimeParentStartTimeTicks === "string";
}

function exactLinuxParentAbsent(record: RuntimeOwnedLinuxProcessPending): boolean {
  const current = readLinuxProcessIdentity(record.runtimeParentPid);
  return !current || current.startTimeTicks !== record.runtimeParentStartTimeTicks;
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

function linuxRecoveryTerminalAuthority(
  claim: RuntimeOwnedProcessClaim,
  guardianPath: string,
  authority: typeof linuxGuardianTerminalAuthority,
): boolean {
  if (!("startTimeTicks" in claim.process)) return false;
  if (authority(claim.process, guardianPath, "/proc", "inertia-done")) {
    return true;
  }
  // A post-exec terminal is valid only after the durable journal records that
  // execution was authorized. A preauth record therefore remains fail-closed
  // even if an unexpected guardian claims the authenticated terminal name.
  return claim.state !== "preauth"
    && authority(claim.process, guardianPath, "/proc", "inertia-exdone");
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
  // is the sole authority. Linux missing roots can be retired only after the
  // already-claimed process group is absent. macOS uses its private session.
  if (platform !== "linux") return false;
  if (missingRootProcessGroupAbsent(claim, kill)) return true;
  for (let poll = 0; poll < PROCESS_GROUP_DRAIN_POLLS; poll += 1) {
    if (Date.now() + PROCESS_GROUP_DRAIN_POLL_MS >= deadlineAt) return false;
    await wait(PROCESS_GROUP_DRAIN_POLL_MS);
    if (missingRootProcessGroupAbsent(claim, kill)) return true;
  }
  return false;
}

async function waitForDarwinSessionDrain(
  claim: RuntimeOwnedProcessClaim,
  readIdentity: (
    pid: number,
  ) => ObservedRuntimeOwnedProcessIdentity | null,
  readSessionEmpty: (sessionId: number) => boolean,
  deadlineAt: number,
  wait: (durationMs: number) => Promise<void>,
): Promise<boolean> {
  if (!("sessionId" in claim.process)) return false;
  const { pid, sessionId } = claim.process;
  for (let poll = 0; poll <= PROCESS_GROUP_DRAIN_POLLS; poll += 1) {
    let identity: ObservedRuntimeOwnedProcessIdentity | null | undefined;
    let sessionEmpty: boolean | undefined;
    try {
      identity = readIdentity(pid);
    } catch {
      // A terminating Darwin process can briefly be present while libproc no
      // longer exposes its birth identity. Session emptiness remains the exact
      // containment proof; transiently unreadable state is retried to deadline.
    }
    try {
      sessionEmpty = readSessionEmpty(sessionId);
    } catch {
      // An unreadable session is not empty and cannot authorize retirement.
    }
    if (
      identity
      && !RuntimeOwnedProcessJournal.identityMatches(claim, identity)
    ) return false;
    if (!identity && sessionEmpty) return true;
    if (Date.now() + PROCESS_GROUP_DRAIN_POLL_MS >= deadlineAt) {
      return false;
    }
    await wait(PROCESS_GROUP_DRAIN_POLL_MS);
  }
  return false;
}

/**
 * Recovers one durable generation without guessing process ownership.
 *
 * Legacy pending claims stay fail-closed. A guarded macOS pending intent can
 * be retired after its runtime parent is absent because the guardian cannot
 * fork its command until the exact owned claim is durably published. Owned
 * claims are killed only while their platform-specific birth identity still
 * matches. Reused roots stay fail-closed and are never signalled. Windows uses
 * its named Job Object. Linux uses the exact claimed process group. macOS asks
 * the exact guardian to drain its private process session, including PTY groups.
 */
export function recoverRuntimeOwnedProcesses(
  dataDirectory: string,
  runtimeGenerationId: string,
  systemBootId: string,
  options: RuntimeOwnedProcessRecoveryOptions,
): boolean | Promise<boolean> | null {
  const platform = options.platform ?? process.platform;
  const linuxTerminalAuthority = options.linuxTerminalAuthority
    ?? linuxGuardianTerminalAuthority;
  const signalLinuxGuardian = options.signalLinuxGuardian
    ?? signalLinuxGuardianExact;
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
      const recover = options.recoverWindowsJob ?? recoverWindowsRuntimeJob;
      const recovered = await (options.windowsRuntimeJobAssembly
        ? recover(containment, options.deadlineAt, {
            assembly: options.windowsRuntimeJobAssembly,
          })
        : recover(containment, options.deadlineAt));
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
    for (const record of pending) {
      if (record.systemBootId !== systemBootId) {
        if (!journal.release(record.ownershipId)) return false;
        continue;
      }
      if (
        !((platform === "darwin" && guardedDarwinPending(record)
          && exactPidAbsent(record.runtimeParentPid, kill))
          || (platform === "linux" && guardedLinuxPending(record)
            && exactLinuxParentAbsent(record)))
        || !journal.release(record.ownershipId)
      ) return false;
    }
    const forceKill = options.forceKill ?? forceKillRuntimeProcessTree;
    const readIdentity = options.readIdentity
      ?? ((pid: number) => readProcessIdentity(
        pid,
        platform,
        options.deadlineAt,
        options.darwinGuardianPath,
      ));
    const readDarwinSessionEmpty = options.readDarwinSessionEmpty
      ?? ((sessionId: number) => {
        if (!options.darwinGuardianPath) {
          throw new Error("The macOS runtime process guardian is unavailable.");
        }
        return darwinProcessSessionEmpty(
          sessionId,
          options.darwinGuardianPath,
          { deadlineAt: options.deadlineAt },
        );
      });
    for (const record of records) {
      if (record.state !== "preauth" && record.state !== "owned" && record.state !== "retiring") continue;
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
          platform === "linux"
          && (record.state === "preauth" || record.state === "retiring")
          && journal.release(record.ownershipId)
        ) continue;
        if (platform === "linux" && options.darwinGuardianPath) return false;
        if (platform === "darwin") {
          // A missing guardian and an empty birth session do not prove that a
          // fork-tainted descendant is gone: it may have double-forked,
          // called setsid(), and reparented before the guardian's bounded
          // census. Drain the exact session to reduce live work, but retain
          // the durable claim for the existing explicit modern-Darwin
          // recovery authority. Silent recovery here would allow an escaped
          // process to run beside a replacement runtime.
          await waitForDarwinSessionDrain(
            record,
            readIdentity,
            readDarwinSessionEmpty,
            options.deadlineAt,
            waitForProcessGroupDrain,
          );
          return false;
        }
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
        platform === "linux"
        && (record.state === "preauth" || record.state === "owned")
        && options.darwinGuardianPath
        && "startTimeTicks" in identity
        && "startTimeTicks" in record.process
      ) {
        while (!linuxRecoveryTerminalAuthority(
          record,
          options.darwinGuardianPath,
          linuxTerminalAuthority,
        )) {
          if (Date.now() + PROCESS_GROUP_DRAIN_POLL_MS >= options.deadlineAt) return false;
          await waitForProcessGroupDrain(PROCESS_GROUP_DRAIN_POLL_MS);
          const current = readIdentity(identity.pid);
          if (!current) {
            if (record.state === "preauth" && journal.release(record.ownershipId)) break;
            return false;
          }
          if (!RuntimeOwnedProcessJournal.identityMatches(record, current)) return false;
        }
        if (record.state === "preauth") {
          const currentRecords = journal.records(runtimeGenerationId);
          if (!currentRecords) return false;
          if (!currentRecords.some((candidate) =>
            candidate.ownershipId === record.ownershipId)) continue;
        }
        if (record.state === "owned" && !journal.retire(record.ownershipId)) return false;
        if (!signalLinuxGuardian(record.process, options.darwinGuardianPath, "kill")) return false;
        while (Date.now() < options.deadlineAt && readIdentity(identity.pid)) {
          await waitForProcessGroupDrain(PROCESS_GROUP_DRAIN_POLL_MS);
        }
        if (readIdentity(identity.pid) || !journal.release(record.ownershipId)) return false;
        continue;
      }
      if (platform === "linux" && record.state === "retiring") {
        if (
          !options.darwinGuardianPath
          || !("startTimeTicks" in identity)
          || !("startTimeTicks" in record.process)
          || !linuxRecoveryTerminalAuthority(
            record,
            options.darwinGuardianPath,
            linuxTerminalAuthority,
          )
        ) return false;
        if (!signalLinuxGuardian(record.process, options.darwinGuardianPath, "kill")) return false;
        while (Date.now() < options.deadlineAt) {
          const current = readIdentity(identity.pid);
          if (!current) break;
          if (!RuntimeOwnedProcessJournal.identityMatches(record, current)) return false;
          await waitForProcessGroupDrain(PROCESS_GROUP_DRAIN_POLL_MS);
        }
        if (readIdentity(identity.pid) || !journal.release(record.ownershipId)) return false;
        continue;
      }
      if (platform === "darwin") {
        if (
          !("sessionId" in identity)
          || identity.sessionId !== identity.pid
          || identity.processGroupId !== identity.pid
          || Date.now() >= options.deadlineAt
        ) return false;
        try {
          verifiedKill(record, kill, readIdentity)(identity.pid, "SIGTERM");
        } catch (error) {
          if (!(
            error
            && typeof error === "object"
            && "code" in error
            && error.code === "ESRCH"
          )) return false;
        }
        // A cancellation result cannot distinguish a fully drained guardian
        // from its fork-tainted uncertain-containment exit. Drain the exact
        // birth session, retain the claim, and require the explicit modern
        // recovery snapshot before a replacement runtime can start.
        await waitForDarwinSessionDrain(
          record,
          readIdentity,
          readDarwinSessionEmpty,
          options.deadlineAt,
          waitForProcessGroupDrain,
        );
        return false;
      }
      if (
        identity.processGroupId !== identity.pid
        || Date.now() >= options.deadlineAt
      ) return false;
      if (
        platform === "linux"
        && (!options.darwinGuardianPath
          || !("startTimeTicks" in identity)
          || !linuxTerminalAuthority(identity, options.darwinGuardianPath))
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
  windowsRuntimeJobAssembly?: WindowsRuntimeJobAssembly;
}): Promise<boolean> | null {
  const platform = options.platform ?? process.platform;
  if (!supportedRuntimeOwnedProcessPlatform(platform)) return null;
  options.leases.refresh();
  if (!options.leases.isValid()) return null;
  const journal = new RuntimeOwnedProcessJournal(options.dataDirectory, {
    platform,
    ...(options.darwinGuardianPath
      ? { darwinGuardianPath: options.darwinGuardianPath }
      : {}),
  });
  // Startup is the only mutation boundary allowed to repair an interrupted
  // session fence. Keep direct RuntimeOwnedProcessJournal readers fail-closed.
  if (!journal.repairSessionCrashPrefixes()) return null;
  const prior = options.leases.all().filter((lease) => (
    lease.systemBootId === options.systemBootId
    || (platform === "linux"
      && journal.records(lease.runtimeGenerationId) !== null)
  ));
  if (prior.length === 0) return null;
  if (prior.some((lease) => journal.records(lease.runtimeGenerationId) === null)) {
    return null;
  }
  return (async () => {
    for (const lease of prior) {
      const recovered = recoverRuntimeOwnedProcesses(
        options.dataDirectory,
        lease.runtimeGenerationId,
        lease.systemBootId,
        {
          deadlineAt: options.deadlineAt,
          platform,
          ...(options.darwinGuardianPath
            ? { darwinGuardianPath: options.darwinGuardianPath }
            : {}),
          ...(options.windowsRuntimeJobAssembly
            ? { windowsRuntimeJobAssembly: options.windowsRuntimeJobAssembly }
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
