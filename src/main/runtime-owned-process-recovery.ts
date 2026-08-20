import {
  readLinuxProcessIdentity,
  RuntimeOwnedProcessJournal,
  type RuntimeOwnedProcessClaim,
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
  readonly readIdentity?: typeof readLinuxProcessIdentity;
}

function verifiedKill(
  claim: RuntimeOwnedProcessClaim,
  kill: Kill,
  readIdentity: typeof readLinuxProcessIdentity,
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

/**
 * Recovers one durable generation without guessing process ownership.
 *
 * A pending claim represents the crash window between durable spawn intent and
 * an exact child identity, so it stays fail-closed. Owned claims are killed
 * only while their Linux start-time/process-group identity still matches. A
 * missing or reused root also stays fail-closed: after its ancestry disappears
 * Linux cannot prove that it left no descendant in another process group.
 */
export function recoverRuntimeOwnedProcesses(
  dataDirectory: string,
  runtimeGenerationId: string,
  systemBootId: string,
  options: RuntimeOwnedProcessRecoveryOptions,
): boolean | Promise<boolean> | null {
  if ((options.platform ?? process.platform) !== "linux") return null;
  const journal = new RuntimeOwnedProcessJournal(dataDirectory);
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
    const readIdentity = options.readIdentity ?? readLinuxProcessIdentity;
    for (const record of records) {
      if (record.state !== "owned") return false;
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
      if (
        !identity
        || !RuntimeOwnedProcessJournal.identityMatches(record, identity)
      ) {
        return false;
      }
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
}): Promise<boolean> | null {
  if (process.platform !== "linux") return null;
  options.leases.refresh();
  const prior = options.leases.all().filter((lease) =>
    lease.systemBootId === options.systemBootId);
  if (prior.length === 0) return null;
  const journal = new RuntimeOwnedProcessJournal(options.dataDirectory);
  if (prior.some((lease) => journal.records(lease.runtimeGenerationId) === null)) {
    return null;
  }
  return (async () => {
    for (const lease of prior) {
      const recovered = recoverRuntimeOwnedProcesses(
        options.dataDirectory,
        lease.runtimeGenerationId,
        options.systemBootId,
        { deadlineAt: options.deadlineAt },
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
  if (process.platform !== "linux") return true;
  try {
    return new RuntimeOwnedProcessJournal(dataDirectory)
      .finishSession(runtimeGenerationId);
  } catch {
    return false;
  }
}
