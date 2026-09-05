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
  recoverLinuxGuardianTerminalExact,
} from "../node/runtime-owned-process-linux.js";
export { readDarwinProcessIdentity } from "../node/runtime-owned-processes.js";

type Kill = (pid: number, signal?: NodeJS.Signals | number) => true;
const PROCESS_GROUP_DRAIN_POLL_MS = 20;
const PROCESS_GROUP_DRAIN_POLLS = 50;
const RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS = 10;
const RUNTIME_OWNED_JOURNAL_SETTLE_BUDGET_MS = 100;

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
  readonly recoverLinuxGuardian?: typeof recoverLinuxGuardianTerminalExact;
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

async function releaseRuntimeOwnedProcessClaimAfterProof(
  journal: RuntimeOwnedProcessJournal,
  runtimeGenerationId: string,
  ownershipId: string,
  deadlineAt: number,
  wait: (durationMs: number) => Promise<void>,
): Promise<boolean> {
  while (true) {
    // Cleanup proof may become observable on the event-loop turn that reaches
    // the deadline. Preserve the pre-settlement behavior of making one exact
    // release attempt, then keep any race settlement inside the outer bound.
    if (journal.release(ownershipId)) return true;
    const current = journal.records(runtimeGenerationId);
    if (current && !current.some((record) =>
      record.ownershipId === ownershipId)) return true;
    if (Date.now() + RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS >= deadlineAt) {
      return false;
    }
    await wait(RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS);
  }
}

async function readRuntimeOwnedProcessRecordsAfterSettle(
  journal: RuntimeOwnedProcessJournal,
  runtimeGenerationId: string,
  deadlineAt: number,
  wait: (durationMs: number) => Promise<void>,
): Promise<ReturnType<RuntimeOwnedProcessJournal["records"]>> {
  while (
    Date.now() + RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS < deadlineAt
  ) {
    await wait(RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS);
    const records = journal.records(runtimeGenerationId);
    if (records) return records;
  }
  return null;
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
  const recoverLinuxGuardian = options.recoverLinuxGuardian
    ?? recoverLinuxGuardianTerminalExact;
  if (!supportedRuntimeOwnedProcessPlatform(platform)) return null;
  const journal = new RuntimeOwnedProcessJournal(dataDirectory, {
    platform,
    ...(options.darwinGuardianPath
      ? { darwinGuardianPath: options.darwinGuardianPath }
      : {}),
  });
  if (platform === "win32") {
    // A valid journal with no such generation is a stable absence, not an
    // in-flight writer transition. Preserve the synchronous fail-closed signal
    // used by startup recovery while retrying only an unreadable generation.
    const initialSession = journal.sessionExact(runtimeGenerationId);
    if (initialSession === null) return null;
    return (async () => {
      const waitForJournalSettle = options.waitForProcessGroupDrain
        ?? ((durationMs: number) => new Promise<void>((resolve) => {
          setTimeout(resolve, durationMs);
        }));
      let exactSession = initialSession;
      while (!exactSession) {
        if (
          Date.now() + RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS
            >= options.deadlineAt
        ) return false;
        await waitForJournalSettle(RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS);
        const observedSession = journal.sessionExact(runtimeGenerationId);
        if (observedSession === null) return false;
        exactSession = observedSession;
      }
      // Recovery is entered only for an exited/prior generation. Fence its
      // writer capability before inspecting it so an admission interrupted by
      // process death becomes an uncommitted, safely discardable prefix.
      while (!journal.fenceSessionExact(exactSession)) {
        if (
          Date.now() + RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS
            >= options.deadlineAt
        ) return false;
        await waitForJournalSettle(RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS);
      }
      let inspection = journal.inspectGeneration(runtimeGenerationId);
      while (!inspection) {
        if (
          Date.now() + RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS
            >= options.deadlineAt
        ) return false;
        await waitForJournalSettle(RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS);
        inspection = journal.inspectGeneration(runtimeGenerationId);
      }
      const { containment, records, session } = inspection;
      if (
        !session
        || records.some((record) =>
          record.systemBootId !== session.systemBootId)
      ) return false;
      if (!containment) return records.length === 0;
      const recover = options.recoverWindowsJob ?? recoverWindowsRuntimeJob;
      const recovered = await (options.windowsRuntimeJobAssembly
        ? recover(containment, options.deadlineAt, {
            assembly: options.windowsRuntimeJobAssembly,
          })
        : recover(containment, options.deadlineAt));
      if (!recovered) return false;
      // RecoverManaged proves the complete named Job Object is empty before it
      // returns. The dying runtime can still deliver a child `close` callback
      // and retire the same durable claim while that native proof is in
      // flight. Journal rename/unlink is deliberately fail closed, so a reader
      // can transiently observe null while that exact retirement commits. Once
      // the Job is proven empty, retry only journal settlement to the existing
      // supervisor deadline; never guess ownership or clear a malformed record.
      while (true) {
        const recoveredRecords = journal.records(runtimeGenerationId);
        if (recoveredRecords?.length === 0) return true;
        for (const record of recoveredRecords ?? []) {
          journal.release(record.ownershipId);
        }
        const remaining = journal.records(runtimeGenerationId);
        if (remaining?.length === 0) return true;
        if (Date.now() + RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS >= options.deadlineAt) {
          return false;
        }
        await waitForJournalSettle(RUNTIME_OWNED_JOURNAL_SETTLE_POLL_MS);
      }
    })();
  }
  let records = journal.records(runtimeGenerationId);
  const session = journal.sessionExact(runtimeGenerationId);
  if (!records && session === null) return null;
  if (records?.length === 0) return true;
  return (async () => {
    const kill = options.kill ?? process.kill;
    const waitForProcessGroupDrain = options.waitForProcessGroupDrain
      ?? ((durationMs: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
      }));
    // Keep journal retry time inside the existing supervisor envelope. Process
    // proofs stop slightly earlier; the original deadline remains authoritative
    // for post-proof claim settlement.
    const processProofDeadlineAt =
      options.deadlineAt - RUNTIME_OWNED_JOURNAL_SETTLE_BUDGET_MS;
    records ??= await readRuntimeOwnedProcessRecordsAfterSettle(
      journal,
      runtimeGenerationId,
      options.deadlineAt,
      waitForProcessGroupDrain,
    );
    if (!records) return false;
    if (records.length === 0) return true;
    const pending = records.filter((record) => record.state === "pending");
    for (const record of pending) {
      if (record.systemBootId !== systemBootId) {
        if (!await releaseRuntimeOwnedProcessClaimAfterProof(
          journal,
          runtimeGenerationId,
          record.ownershipId,
          options.deadlineAt,
          waitForProcessGroupDrain,
        )) return false;
        continue;
      }
      const unstarted = (platform === "darwin" && guardedDarwinPending(record)
          && exactPidAbsent(record.runtimeParentPid, kill))
          || (platform === "linux" && guardedLinuxPending(record)
            && exactLinuxParentAbsent(record));
      if (!unstarted || !await releaseRuntimeOwnedProcessClaimAfterProof(
        journal,
        runtimeGenerationId,
        record.ownershipId,
        options.deadlineAt,
        waitForProcessGroupDrain,
      )) return false;
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
        if (!await releaseRuntimeOwnedProcessClaimAfterProof(
          journal,
          runtimeGenerationId,
          record.ownershipId,
          options.deadlineAt,
          waitForProcessGroupDrain,
        )) return false;
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
          && await releaseRuntimeOwnedProcessClaimAfterProof(
            journal,
            runtimeGenerationId,
            record.ownershipId,
            options.deadlineAt,
            waitForProcessGroupDrain,
          )
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
          processProofDeadlineAt,
          waitForProcessGroupDrain,
        )
          || !await releaseRuntimeOwnedProcessClaimAfterProof(
            journal,
            runtimeGenerationId,
            record.ownershipId,
            options.deadlineAt,
            waitForProcessGroupDrain,
          )
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
          if (Date.now() + PROCESS_GROUP_DRAIN_POLL_MS >= processProofDeadlineAt) return false;
          await waitForProcessGroupDrain(PROCESS_GROUP_DRAIN_POLL_MS);
          const current = readIdentity(identity.pid);
          if (!current) {
            if (record.state === "preauth" &&
              await releaseRuntimeOwnedProcessClaimAfterProof(
                journal,
                runtimeGenerationId,
                record.ownershipId,
                options.deadlineAt,
                waitForProcessGroupDrain,
              )) break;
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
        if (Date.now() >= processProofDeadlineAt) return false;
        if (record.state === "owned" && !journal.retire(record.ownershipId)) return false;
        if (!recoverLinuxGuardian(record.process, options.darwinGuardianPath)) return false;
        while (Date.now() < processProofDeadlineAt && readIdentity(identity.pid)) {
          await waitForProcessGroupDrain(PROCESS_GROUP_DRAIN_POLL_MS);
        }
        if (readIdentity(identity.pid) ||
          !await releaseRuntimeOwnedProcessClaimAfterProof(
            journal,
            runtimeGenerationId,
            record.ownershipId,
            options.deadlineAt,
            waitForProcessGroupDrain,
          )) return false;
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
        if (Date.now() >= processProofDeadlineAt) return false;
        if (!recoverLinuxGuardian(record.process, options.darwinGuardianPath)) return false;
        while (Date.now() < processProofDeadlineAt) {
          const current = readIdentity(identity.pid);
          if (!current) break;
          if (!RuntimeOwnedProcessJournal.identityMatches(record, current)) return false;
          await waitForProcessGroupDrain(PROCESS_GROUP_DRAIN_POLL_MS);
        }
        if (readIdentity(identity.pid) ||
          !await releaseRuntimeOwnedProcessClaimAfterProof(
            journal,
            runtimeGenerationId,
            record.ownershipId,
            options.deadlineAt,
            waitForProcessGroupDrain,
          )) return false;
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
        || Date.now() >= processProofDeadlineAt
      ) return false;
      if (
        platform === "linux"
        && (!options.darwinGuardianPath
          || !("startTimeTicks" in identity)
          || !linuxTerminalAuthority(identity, options.darwinGuardianPath))
      ) return false;
      const confirmed = await forceKill(identity.pid, {
        rootProcessGroup: true,
        deadlineAt: processProofDeadlineAt,
        kill: verifiedKill(record, kill, readIdentity),
      }).catch(() => false);
      if (!confirmed || !await releaseRuntimeOwnedProcessClaimAfterProof(
        journal,
        runtimeGenerationId,
        record.ownershipId,
        options.deadlineAt,
        waitForProcessGroupDrain,
      )) return false;
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
  if (prior.some((lease) => {
    const runtimeGenerationId = lease.runtimeGenerationId;
    if (!options.receipts.has(runtimeGenerationId)) {
      return journal.records(runtimeGenerationId) === null;
    }
    const session = journal.sessionExact(runtimeGenerationId);
    return session === undefined
      || (session !== null && journal.records(runtimeGenerationId) === null);
  })) {
    return null;
  }
  return (async () => {
    for (const lease of prior) {
      if (options.receipts.has(lease.runtimeGenerationId)) continue;
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
      const runtimeGenerationId = lease.runtimeGenerationId;
      if (options.receipts.has(runtimeGenerationId)) {
        const session = journal.sessionExact(runtimeGenerationId);
        if (
          session === undefined
          || (session && !journal.finishSessionExact(session))
        ) return false;
      } else if (!journal.finishSession(
        runtimeGenerationId,
        () => options.receipts.publish(runtimeGenerationId),
      )) return false;
      if (!options.leases.clearRuntimeGeneration(runtimeGenerationId)) return false;
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
