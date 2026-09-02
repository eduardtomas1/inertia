import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as waitForTimeout } from "node:timers/promises";

import {
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
} from "../node/direct-runtime-journal.js";
import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import { RuntimeOwnedProcessJournal } from "../node/runtime-owned-processes.js";
import {
  captureModernDarwinRecoverySnapshot,
  descriptorForModernDarwinRecoveryAuthority,
  modernDarwinRecoveryAuthorityMatches,
  modernDarwinRecoveryJournalMatches,
  modernDarwinRecoverySnapshotRootsAbsent,
  ModernDarwinRecoveryAuthorityJournal,
  type ModernDarwinRecoveryAuthorityDescriptor,
  type ModernDarwinRecoveryRootObservation,
  type ModernDarwinRecoverySnapshot,
} from "../node/runtime-modern-recovery-authorities.js";
import { runtimeCleanupReceiptIds } from "./runtime-cleanup-receipts.js";
import {
  LegacyRuntimeRecoveryAuthorityJournal,
  type LegacyRuntimeRecoveryPlatform,
} from "./runtime-legacy-recovery-authorities.js";
import { readSystemBootId } from "./system-boot-id.js";
import { recoverRuntimeOwnedProcesses } from "./runtime-owned-process-recovery.js";
export { runtimeProcessEnvironment } from "./runtime-process-environment.js";

export interface RuntimeBootstrapSafety {
  systemBootId: string;
  preserveAttachments: boolean;
  legacyRecoveryCandidates: readonly string[];
}

export interface ModernDarwinBootstrapRecovery {
  readonly authority: ModernDarwinRecoveryAuthorityDescriptor | null;
  readonly candidate: ModernDarwinRecoverySnapshot | null;
  readonly blocked: boolean;
}

export const MODERN_DARWIN_RECOVERY_DIALOG_DETAIL =
  "Inertia already attempted exact automatic recovery. This fallback will NOT kill any surviving process. Continue only after closing every older Inertia window and any agent or terminal process from Inertia that you can still see. The exact recorded roots and state will be checked again before recovery; your projects and attachments will be preserved, and affected runs will be marked as interrupted instead of completed.";

export const LEGACY_RUNTIME_RECOVERY_DIALOG_DETAIL =
  "Inertia cannot prove that every older agent or terminal process has stopped. This fallback will NOT kill any surviving process. Continue only after closing every older Inertia window and any agent or terminal process from Inertia that you can still see. The recorded state will be checked again before recovery; your projects and attachments will be preserved, and affected runs will be marked as interrupted instead of completed.";

const MAX_RUNTIME_OWNERSHIP_LEAVES = 256;
const DARWIN_RETIREMENT_SETTLE_MS = 500;
const DARWIN_RETIREMENT_POLL_MS = 10;

function sameRuntimeGenerationLease(
  left: Readonly<{
    runtimeGenerationId: string;
    systemBootId: string;
    createdAt: string;
  }>,
  right: Readonly<{
    runtimeGenerationId: string;
    systemBootId: string;
    createdAt: string;
  }>,
): boolean {
  return left.runtimeGenerationId === right.runtimeGenerationId
    && left.systemBootId === right.systemBootId
    && left.createdAt === right.createdAt;
}

function legacyRecoveryPlatform(
  platform: NodeJS.Platform,
): LegacyRuntimeRecoveryPlatform | null {
  return platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : null;
}

function unavailableLegacyRecoveryCandidates(
  dataDirectory: string,
  generationLeases: RuntimeGenerationLeaseJournal,
  authorities: LegacyRuntimeRecoveryAuthorityJournal,
  platform: NodeJS.Platform,
  systemBootId: string,
): string[] {
  const supportedPlatform = legacyRecoveryPlatform(platform);
  if (
    !supportedPlatform
    || !generationLeases.isValid()
  ) return [];
  const separatelyAuthorizedModernIds = new Set<string>();
  try {
    // v0.0.44 never wrote runtime-owned session, claim, or containment leaves
    // alongside these fallback leases. Any such leaf represents a newer exact
    // ownership record, an incomplete mutation, or invalid storage. Every one
    // of those cases must stay on the exact fail-closed recovery path.
    const ownedLeaves = listDirectRuntimeJournalLeaves(
      pinDirectRuntimeJournalRoot(dataDirectory),
      ".runtime-owned-",
      MAX_RUNTIME_OWNERSHIP_LEAVES,
    );
    if (supportedPlatform === "darwin") {
      const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
        platform: "darwin",
      });
      const allLeases = generationLeases.all();
      const modernLeases = allLeases.filter(({ runtimeGenerationId }) => (
        owned.records(runtimeGenerationId) !== null
      ));
      const modernAuthority = modernLeases.length > 0
        ? new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending()
        : null;
      if (
        modernLeases.length > 0
        && (
          !modernAuthority
          || modernAuthority.snapshot.systemBootId !== systemBootId
          || !modernDarwinRecoveryJournalMatches(
            dataDirectory,
            modernAuthority,
          )
        )
      ) return [];
      let expectedLeaves = 0;
      const modernGenerationIds = new Set(
        modernAuthority?.snapshot.generations.map(
          ({ lease }) => lease.runtimeGenerationId,
        ) ?? [],
      );
      for (const runtimeGenerationId of modernGenerationIds) {
        separatelyAuthorizedModernIds.add(runtimeGenerationId);
      }
      for (const lease of allLeases) {
        const records = owned.records(lease.runtimeGenerationId);
        if (
          lease.systemBootId === "unavailable"
          && !modernGenerationIds.has(lease.runtimeGenerationId)
        ) {
          if (records !== null) return [];
          continue;
        }
        if (records === null || owned.containment(
          lease.runtimeGenerationId,
        ) !== null) return [];
        const inspection = owned.inspectGeneration(
          lease.runtimeGenerationId,
        );
        if (!inspection?.session) return [];
        expectedLeaves += 1
          + Number(inspection.sessionWriterPresent)
          + records.length;
      }
      // records() repairs only safe pre-admission/consume transients. Exact
      // leaf accounting rejects any unbound session, claim, or foreign modern
      // state while allowing a separately consent-bound current-boot batch.
      const repairedLeaves = listDirectRuntimeJournalLeaves(
        pinDirectRuntimeJournalRoot(dataDirectory),
        ".runtime-owned-",
        MAX_RUNTIME_OWNERSHIP_LEAVES,
      );
      if (repairedLeaves.length !== expectedLeaves) return [];
    } else if (ownedLeaves.length > 0) return [];
  } catch {
    return [];
  }
  const alreadyAuthorized = new Set(authorities.pending(
    supportedPlatform,
    systemBootId,
  ));
  return generationLeases.all()
    .filter((lease) => (
      lease.systemBootId === "unavailable"
      && !separatelyAuthorizedModernIds.has(lease.runtimeGenerationId)
      && !alreadyAuthorized.has(lease.runtimeGenerationId)
    ))
    .map(({ runtimeGenerationId }) => runtimeGenerationId);
}

export function runtimeDataPath(configuredPath: string | undefined, userDataPath: string): string {
  return configuredPath ? resolve(configuredPath) : join(userDataPath, "runtime");
}

export function runtimeWorkspacePath(
  configuredPath: string | undefined,
  homePath: string,
  directoryName = "Inertia",
): string {
  return configuredPath ? resolve(configuredPath) : join(homePath, directoryName);
}

export function prepareRuntimeBootstrapSafety(
  dataDirectory: string,
  platform: NodeJS.Platform = process.platform,
): RuntimeBootstrapSafety {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const systemBootId = readSystemBootId() ?? "unavailable";
  const generationLeases = new RuntimeGenerationLeaseJournal(dataDirectory);
  const ownedProcesses = new RuntimeOwnedProcessJournal(dataDirectory);
  const ownedProcessCrashPrefixesRepaired =
    generationLeases.isValid()
    && ownedProcesses.repairSessionCrashPrefixes();
  const unleasedOwnedProcessSessionsRepaired =
    ownedProcessCrashPrefixesRepaired
    && generationLeases.isValid()
    && ownedProcesses.repairUnleasedEmptySessions(new Set(
      generationLeases.all().map(({ runtimeGenerationId }) =>
        runtimeGenerationId),
    ));
  const legacyAuthorities = new LegacyRuntimeRecoveryAuthorityJournal(
    dataDirectory,
  );
  const supportedLegacyPlatform = legacyRecoveryPlatform(platform);
  const legacyAuthoritiesReady = supportedLegacyPlatform !== null
    && legacyAuthorities.retireExpired(
      supportedLegacyPlatform,
      systemBootId,
    );
  const receiptsRetired = runtimeCleanupReceiptIds(dataDirectory).every(
    (generationId) => generationLeases.clearRuntimeGeneration(generationId),
  );
  const priorBootRetired = ownedProcesses.clearPriorBootSessions(systemBootId)
    && generationLeases.clearPriorBootSessions(systemBootId);
  return {
    systemBootId,
    preserveAttachments: !unleasedOwnedProcessSessionsRepaired
      || !receiptsRetired
      || !priorBootRetired
      || generationLeases.safetyLocked(),
    legacyRecoveryCandidates: legacyAuthoritiesReady
      ? unavailableLegacyRecoveryCandidates(
          dataDirectory,
          generationLeases,
          legacyAuthorities,
          platform,
          systemBootId,
        )
      : [],
  };
}

export function authorizeLegacyRuntimeRecovery(
  dataDirectory: string,
  runtimeGenerationIds: readonly string[],
  systemBootId: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const supportedPlatform = legacyRecoveryPlatform(platform);
  if (
    !supportedPlatform
    || runtimeGenerationIds.length < 1
    || runtimeGenerationIds.length > 32
    || new Set(runtimeGenerationIds).size !== runtimeGenerationIds.length
  ) return false;
  try {
    const generationLeases = new RuntimeGenerationLeaseJournal(dataDirectory);
    const authorities = new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory);
    const eligible = unavailableLegacyRecoveryCandidates(
      dataDirectory,
      generationLeases,
      authorities,
      supportedPlatform,
      systemBootId,
    );
    const requested = [...runtimeGenerationIds].sort();
    if (
      eligible.length !== requested.length
      || [...eligible].sort().some((generationId, index) => (
        generationId !== requested[index]
      ))
    ) return false;
    const pending = authorities.pending(supportedPlatform, systemBootId);
    if (!authorities.publishBatch(
      runtimeGenerationIds,
      supportedPlatform,
      systemBootId,
    )) return false;
    const allRuntimeGenerationIds = [
      ...new Set([...pending, ...runtimeGenerationIds]),
    ];
    const persisted = new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory);
    return allRuntimeGenerationIds.every((runtimeGenerationId) =>
      persisted.has(runtimeGenerationId, supportedPlatform, systemBootId));
  } catch {
    return false;
  }
}

/**
 * Completes an already-acknowledged manual retirement, resumes an unchanged
 * user authority, or performs exact guardian/session recovery before any
 * manual fallback is offered. Nothing here guesses process liveness.
 */
export async function prepareModernDarwinBootstrapRecovery(
  dataDirectory: string,
  systemBootId: string,
  guardianPath: string | null,
  options: Omit<ModernDarwinRecoveryRootObservation, "guardianPath"> = {},
): Promise<ModernDarwinBootstrapRecovery> {
  const platform = options.platform ?? process.platform;
  if (
    platform !== "darwin"
    || !guardianPath
  ) return { authority: null, candidate: null, blocked: false };
  try {
    const authorities = new ModernDarwinRecoveryAuthorityJournal(
      dataDirectory,
    );
    const retiring = authorities.retiring();
    if (retiring) {
      if (!authorities.settleRetirement(dataDirectory, retiring)) {
        return { authority: null, candidate: null, blocked: true };
      }
      await waitForTimeout(DARWIN_RETIREMENT_POLL_MS);
      if (!authorities.completeRetirement(dataDirectory, retiring)) {
        return { authority: null, candidate: null, blocked: true };
      }
    }
    const replay = new ModernDarwinRecoveryAuthorityJournal(dataDirectory);
    const pending = replay.pending();
    if (pending) {
      if (
        pending.snapshot.systemBootId === systemBootId
        && modernDarwinRecoveryAuthorityMatches(
          dataDirectory,
          pending,
          {
            guardianPath,
            platform: "darwin",
            deadlineAt: options.deadlineAt,
            ...(options.readDarwinIdentity
              ? { readDarwinIdentity: options.readDarwinIdentity }
              : {}),
            ...(options.pidExists ? { pidExists: options.pidExists } : {}),
          },
        )
      ) {
        return {
          authority: descriptorForModernDarwinRecoveryAuthority(pending),
          candidate: null,
          blocked: false,
        };
      }
      if (!replay.cancelPending(pending)) {
        return { authority: null, candidate: null, blocked: true };
      }
    }

    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    if (!leases.isValid()) {
      return { authority: null, candidate: null, blocked: true };
    }
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    });
    // Session-backed leases are modern state even when a boot probe changed
    // between available and unavailable. That transition is not reboot proof,
    // so preserve the lease's recorded identity for exact cleanup and bind the
    // current observation separately in the manual authority snapshot.
    const allLeases = leases.all();
    const prior = allLeases.filter((lease) => (
      lease.systemBootId !== "unavailable"
      || owned.records(lease.runtimeGenerationId) !== null
    ));
    const initialOwnedLeaves = listDirectRuntimeJournalLeaves(
      pinDirectRuntimeJournalRoot(dataDirectory),
      ".runtime-owned-",
      MAX_RUNTIME_OWNERSHIP_LEAVES,
    );
    const deadlineAt = options.deadlineAt ?? Date.now() + 5_000;
    // Drain every exact recorded guardian/session boundary first, but retain
    // the generation session and lease. A macOS descendant may have escaped
    // its original POSIX session with setsid(), so session emptiness alone is
    // not proof that every descendant stopped and must never auto-authorize
    // provider admission.
    for (const lease of prior) {
      if (owned.records(lease.runtimeGenerationId) === null) continue;
      const recovery = recoverRuntimeOwnedProcesses(
        dataDirectory,
        lease.runtimeGenerationId,
        lease.systemBootId,
        {
          deadlineAt,
          platform: "darwin",
          darwinGuardianPath: guardianPath,
        },
      );
      if (recovery) await Promise.resolve(recovery).catch(() => false);
    }
    if (prior.length === 0) {
      return {
        authority: null,
        candidate: null,
        blocked: initialOwnedLeaves.length > 0,
      };
    }
    // A normal supervisor shutdown can complete while the recovery loop is
    // yielding. Its durable mutation is deliberately ordered as session
    // removal, cleanup-receipt publication, then lease retirement. Sample the
    // exact journals through that short transaction instead of mistaking a
    // legitimate prefix for corrupt state. No state is inferred from absence:
    // every omitted baseline generation still requires its exact receipt.
    const settleDeadlineAt = performance.now() + DARWIN_RETIREMENT_SETTLE_MS;
    const entryLeases = new Map(allLeases.map((lease) => [
      lease.runtimeGenerationId,
      lease,
    ]));
    const baselineLeases = new Map(prior.map((lease) => [
      lease.runtimeGenerationId,
      lease,
    ]));
    let stableResultDigest: string | null = null;
    while (true) {
      let exactResult: ModernDarwinBootstrapRecovery | null = null;
      try {
        const candidate = captureModernDarwinRecoverySnapshot(
          dataDirectory,
          systemBootId,
        );
        const candidateGenerations = new Map(
          candidate?.generations.map((generation) => [
            generation.lease.runtimeGenerationId,
            generation,
          ]) ?? [],
        );
        let coherent = ![...candidateGenerations.keys()].some(
          (runtimeGenerationId) => !baselineLeases.has(runtimeGenerationId),
        );

        const refreshedLeases = new RuntimeGenerationLeaseJournal(dataDirectory);
        coherent &&= refreshedLeases.isValid();
        const currentLeases = new Map(refreshedLeases.all().map((lease) => [
          lease.runtimeGenerationId,
          lease,
        ]));
        coherent &&= [...currentLeases].every(([
          runtimeGenerationId,
          currentLease,
        ]) => {
          const entryLease = entryLeases.get(runtimeGenerationId);
          return Boolean(
            entryLease
            && sameRuntimeGenerationLease(currentLease, entryLease),
          );
        });
        coherent &&= [...entryLeases].every(([
          runtimeGenerationId,
          entryLease,
        ]) => {
          if (baselineLeases.has(runtimeGenerationId)) return true;
          const currentLease = currentLeases.get(runtimeGenerationId);
          return Boolean(
            currentLease
            && sameRuntimeGenerationLease(currentLease, entryLease),
          );
        });
        const cleanupReceiptIds = new Set(runtimeCleanupReceiptIds(dataDirectory));
        const ownedLeaves = listDirectRuntimeJournalLeaves(
          pinDirectRuntimeJournalRoot(dataDirectory),
          ".runtime-owned-",
          MAX_RUNTIME_OWNERSHIP_LEAVES,
        );
        let expectedOwnedLeafCount = 0;
        for (const generation of candidateGenerations.values()) {
          const inspection = owned.inspectGeneration(
            generation.lease.runtimeGenerationId,
          );
          if (!inspection?.session) {
            coherent = false;
            break;
          }
          expectedOwnedLeafCount += 1
            + Number(inspection.sessionWriterPresent)
            + generation.records.length;
        }
        coherent &&= ownedLeaves.length === expectedOwnedLeafCount;

        let settling = false;
        let completed = true;
        for (const [runtimeGenerationId, baselineLease] of baselineLeases) {
          const candidateGeneration = candidateGenerations.get(
            runtimeGenerationId,
          );
          const currentLease = currentLeases.get(runtimeGenerationId);
          if (candidateGeneration) {
            coherent &&= Boolean(
              currentLease
              && sameRuntimeGenerationLease(currentLease, baselineLease)
              && sameRuntimeGenerationLease(
                candidateGeneration.lease,
                baselineLease,
              )
              && !cleanupReceiptIds.has(runtimeGenerationId),
            );
            completed = false;
            continue;
          }
          if (currentLease) {
            coherent &&= sameRuntimeGenerationLease(
              currentLease,
              baselineLease,
            );
            if (cleanupReceiptIds.has(runtimeGenerationId)) {
              coherent &&= refreshedLeases.clearRuntimeGeneration(
                runtimeGenerationId,
              );
            }
            settling = true;
            completed = false;
            continue;
          }
          coherent &&= cleanupReceiptIds.has(runtimeGenerationId);
        }

        if (coherent && !settling) {
          // Re-read the validated receipts in the same turn. A disappearing
          // or consumed receipt cannot become authority for a replacement.
          const confirmedReceiptIds = new Set(runtimeCleanupReceiptIds(
            dataDirectory,
          ));
          coherent &&= [...baselineLeases.keys()].every(
            (runtimeGenerationId) => (
              candidateGenerations.has(runtimeGenerationId)
              || confirmedReceiptIds.has(runtimeGenerationId)
            ),
          );
          if (coherent && candidate) {
            exactResult = { authority: null, candidate, blocked: false };
          } else if (coherent && completed) {
            exactResult = { authority: null, candidate: null, blocked: false };
          }
        }
      } catch {
        // A concurrent atomic journal mutation can make one multi-file sample
        // temporarily incoherent. It never grants authority; retry to the
        // monotonic deadline and remain safety locked if no exact state settles.
      }

      if (exactResult) {
        const digest = JSON.stringify(exactResult.candidate);
        if (stableResultDigest === digest) return exactResult;
        stableResultDigest = digest;
      } else {
        stableResultDigest = null;
      }
      if (performance.now() >= settleDeadlineAt) {
        return { authority: null, candidate: null, blocked: true };
      }
      await waitForTimeout(DARWIN_RETIREMENT_POLL_MS);
    }
  } catch {
    return { authority: null, candidate: null, blocked: true };
  }
}

export function authorizeModernDarwinRuntimeRecovery(
  dataDirectory: string,
  candidate: ModernDarwinRecoverySnapshot,
  systemBootId: string,
  guardianPath: string,
  options: Omit<ModernDarwinRecoveryRootObservation, "guardianPath"> = {},
): ModernDarwinRecoveryAuthorityDescriptor | null {
  const platform = options.platform ?? process.platform;
  if (
    platform !== "darwin"
    || candidate.systemBootId !== systemBootId
  ) return null;
  try {
    const current = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      systemBootId,
    );
    if (!current || JSON.stringify(current) !== JSON.stringify(candidate)) {
      return null;
    }
    const observation = { ...options, platform, guardianPath };
    if (!modernDarwinRecoverySnapshotRootsAbsent(current, observation)) {
      return null;
    }
    const journal = new ModernDarwinRecoveryAuthorityJournal(dataDirectory);
    const descriptor = journal.publish(current);
    const authority = journal.pending();
    if (
      !descriptor
      || !authority
      || !modernDarwinRecoveryAuthorityMatches(
        dataDirectory,
        authority,
        observation,
      )
    ) {
      if (authority) journal.cancelPending(authority);
      return null;
    }
    return descriptor;
  } catch {
    return null;
  }
}

export function runtimeUpdateVersion(currentVersion: string): string {
  const candidate = process.env.NODE_ENV === "test"
    ? process.env.INERTIA_TEST_APP_UPDATE_VERSION
    : undefined;
  return typeof candidate === "string" && /^v?\d+\.\d+\.\d+$/u.test(candidate)
    ? candidate
    : currentVersion;
}
