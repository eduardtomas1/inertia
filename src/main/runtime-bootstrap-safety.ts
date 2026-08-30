import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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
        expectedLeaves += 1 + records.length;
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
    preserveAttachments: !receiptsRetired
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
    if (authorities.retiring()) {
      if (!authorities.completeRetirement(dataDirectory)) {
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
    const prior = leases.all().filter((lease) => (
      owned.records(lease.runtimeGenerationId) !== null
    ));
    const deadlineAt = options.deadlineAt ?? Date.now() + 5_000;
    // Drain every exact recorded guardian/session boundary first, but retain
    // the generation session and lease. A macOS descendant may have escaped
    // its original POSIX session with setsid(), so session emptiness alone is
    // not proof that every descendant stopped and must never auto-authorize
    // provider admission.
    for (const lease of prior) {
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
      return { authority: null, candidate: null, blocked: false };
    }
    const candidate = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      systemBootId,
    );
    if (!candidate) {
      // A normal supervisor shutdown can complete while the recovery loop is
      // yielding: it removes the owned session before consuming the exact
      // generation lease. Re-read the durable journals so that a completely
      // retired batch with its confirmed cleanup receipt is not mistaken for
      // corrupt state, while unproved, partial, or unrelated ownership state
      // remains fail-closed.
      const refreshedLeases = new RuntimeGenerationLeaseJournal(dataDirectory);
      const priorIds = new Set(prior.map(({ runtimeGenerationId }) => (
        runtimeGenerationId
      )));
      const cleanupReceiptIds = new Set(runtimeCleanupReceiptIds(dataDirectory));
      const everyPriorLeaseRetired = refreshedLeases.isValid()
        && refreshedLeases.all().every(({ runtimeGenerationId }) => (
          !priorIds.has(runtimeGenerationId)
        ));
      const everyPriorRetirementConfirmed = [...priorIds].every(
        (runtimeGenerationId) => cleanupReceiptIds.has(runtimeGenerationId),
      );
      const ownedLeaves = listDirectRuntimeJournalLeaves(
        pinDirectRuntimeJournalRoot(dataDirectory),
        ".runtime-owned-",
        MAX_RUNTIME_OWNERSHIP_LEAVES,
      );
      if (
        everyPriorLeaseRetired
        && everyPriorRetirementConfirmed
        && ownedLeaves.length === 0
      ) {
        return { authority: null, candidate: null, blocked: false };
      }
    }
    return {
      authority: null,
      candidate,
      blocked: candidate === null,
    };
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
