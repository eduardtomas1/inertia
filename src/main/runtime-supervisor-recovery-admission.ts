import { RuntimeGenerationLeaseJournal } from
  "../node/runtime-generation-leases.js";
import {
  modernDarwinRecoveryAuthorityMatches,
  modernDarwinRecoveryDescriptorMatches,
  ModernDarwinRecoveryAuthorityJournal,
  type ModernDarwinRecoveryAuthorityDescriptor,
} from "../node/runtime-modern-recovery-authorities.js";
import { RuntimeOwnedProcessJournal } from
  "../node/runtime-owned-processes.js";
import type { RuntimeRecoveryWorkerEvent } from
  "../node/runtime-recovery-process-protocol.js";
import {
  LegacyRuntimeRecoveryAuthorityJournal,
  type LegacyRuntimeRecoveryPlatform,
} from "./runtime-legacy-recovery-authorities.js";
import type { RuntimeProcessRecord } from "./runtime-supervisor-types.js";

interface RuntimeRecoveryAdmissionSuccess {
  readonly ok: true;
  readonly legacyRecoveryAuthorityIds: readonly string[];
  readonly modernDarwinRecoveryAuthority:
    ModernDarwinRecoveryAuthorityDescriptor | null;
}

interface RuntimeRecoveryAdmissionFailure {
  readonly ok: false;
  readonly error: string;
}

export type RuntimeRecoveryAdmissionResult =
  | RuntimeRecoveryAdmissionSuccess
  | RuntimeRecoveryAdmissionFailure;

export interface RuntimeRecoveryEventResult {
  readonly handled: boolean;
  readonly error?: string;
}

function legacyRuntimeRecoveryPlatform(): LegacyRuntimeRecoveryPlatform | null {
  return process.platform === "darwin"
    || process.platform === "linux"
    || process.platform === "win32"
    ? process.platform
    : null;
}

export class RuntimeSupervisorRecoveryAdmission {
  readonly #dataDirectory: string;
  readonly #systemBootId: string;
  readonly #guardianPath: string | null;
  readonly #leases: RuntimeGenerationLeaseJournal;
  readonly #ownedProcesses: RuntimeOwnedProcessJournal;
  readonly #legacyAuthorities: LegacyRuntimeRecoveryAuthorityJournal;
  readonly #modernAuthorities: ModernDarwinRecoveryAuthorityJournal;
  #manualModernRecovery: ModernDarwinRecoveryAuthorityDescriptor | null;

  constructor(options: {
    readonly dataDirectory: string;
    readonly systemBootId: string;
    readonly guardianPath?: string;
    readonly leases: RuntimeGenerationLeaseJournal;
    readonly ownedProcesses: RuntimeOwnedProcessJournal;
    readonly manualModernRecovery?: ModernDarwinRecoveryAuthorityDescriptor;
  }) {
    this.#dataDirectory = options.dataDirectory;
    this.#systemBootId = options.systemBootId;
    this.#guardianPath = options.guardianPath ?? null;
    this.#leases = options.leases;
    this.#ownedProcesses = options.ownedProcesses;
    this.#legacyAuthorities = new LegacyRuntimeRecoveryAuthorityJournal(
      options.dataDirectory,
    );
    this.#modernAuthorities = new ModernDarwinRecoveryAuthorityJournal(
      options.dataDirectory,
    );
    this.#manualModernRecovery = options.manualModernRecovery ?? null;
  }

  requiresManualStartup(): boolean {
    return this.#manualModernRecovery !== null;
  }

  prepare(runtimeGenerationId: string): RuntimeRecoveryAdmissionResult {
    this.#leases.refresh();
    const modernDescriptor = this.#manualModernRecovery;
    const modernAuthority = modernDescriptor
      ? this.#modernAuthorities.pending()
      : null;
    const rootObservation = this.#guardianPath
      ? { guardianPath: this.#guardianPath, platform: "darwin" as const }
      : null;
    if (
      modernDescriptor
      && (
        !rootObservation
        || !modernAuthority
        || modernAuthority.snapshot.systemBootId !== this.#systemBootId
        || !modernDarwinRecoveryDescriptorMatches(
          modernDescriptor,
          modernAuthority,
        )
        || !modernDarwinRecoveryAuthorityMatches(
          this.#dataDirectory,
          modernAuthority,
          rootObservation,
        )
      )
    ) return {
      ok: false,
      error: "The manual macOS runtime recovery authority changed before startup.",
    };

    const legacyPlatform = legacyRuntimeRecoveryPlatform();
    const pendingLegacyIds = legacyPlatform
      ? this.#legacyAuthorities.pending(legacyPlatform, this.#systemBootId)
      : [];
    const pendingLegacy = new Set(pendingLegacyIds);
    const modernIds = new Set(modernDescriptor?.runtimeGenerationIds ?? []);
    const legacyLeaseIds = this.#leases.all()
      .filter((lease) => lease.systemBootId === "unavailable"
        && !modernIds.has(lease.runtimeGenerationId))
      .map(({ runtimeGenerationId }) => runtimeGenerationId)
      .sort();
    // The utility runtime retires the unavailable lease before asking the
    // supervisor to consume its matching authority. A crash in that narrow
    // handoff leaves a valid authority without a lease. Replay the complete
    // authority batch in that state, while continuing to reject any
    // unavailable lease that is not explicitly authorized.
    const exactLegacyBatch = legacyLeaseIds.every((generationId) =>
      pendingLegacy.has(generationId));
    if (
      !exactLegacyBatch
      && (legacyLeaseIds.length > 0 || pendingLegacyIds.length > 0)
    ) return {
      ok: false,
      error: "The manual legacy runtime recovery authority changed before startup.",
    };
    const legacyIds = exactLegacyBatch ? pendingLegacyIds : [];

    if (
      !this.#ownedProcesses.startSession(
        runtimeGenerationId,
        this.#systemBootId,
      )
      || !(
        this.#leases.publish(runtimeGenerationId, this.#systemBootId)
        || this.#leases.publishWithLegacyRecoveryReserve(
          runtimeGenerationId,
          this.#systemBootId,
          legacyIds,
        )
        || (modernDescriptor
          && this.#leases.publishWithModernRecoveryReserve(
            runtimeGenerationId,
            this.#systemBootId,
            modernDescriptor.runtimeGenerationIds,
          ))
        || this.#leases.publishWithManualRecoveryReserve(
          runtimeGenerationId,
          this.#systemBootId,
          legacyIds,
          modernDescriptor?.runtimeGenerationIds ?? [],
        )
      )
    ) {
      this.#ownedProcesses.finishSession(runtimeGenerationId);
      return {
        ok: false,
        error: "The runtime generation ownership lease could not be persisted.",
      };
    }
    if (
      modernDescriptor
      && (
        !rootObservation
        || !modernAuthority
        || modernAuthority.snapshot.systemBootId !== this.#systemBootId
        || !modernDarwinRecoveryAuthorityMatches(
          this.#dataDirectory,
          modernAuthority,
          rootObservation,
          runtimeGenerationId,
        )
      )
    ) return this.#rollback(
      runtimeGenerationId,
      "The recorded macOS process state changed before recovery could start.",
    );

    this.#leases.refresh();
    const exactLegacyIds = this.#leases.all()
      .filter((lease) => lease.systemBootId === "unavailable"
        && lease.runtimeGenerationId !== runtimeGenerationId
        && !modernIds.has(lease.runtimeGenerationId))
      .map(({ runtimeGenerationId }) => runtimeGenerationId)
      .sort();
    if (exactLegacyIds.some((generationId) =>
      !legacyIds.includes(generationId))) return this.#rollback(
      runtimeGenerationId,
      "The manual legacy runtime recovery authority changed before launch.",
    );
    return {
      ok: true,
      legacyRecoveryAuthorityIds: legacyIds,
      modernDarwinRecoveryAuthority: modernDescriptor,
    };
  }

  consume(
    record: RuntimeProcessRecord,
    event: RuntimeRecoveryWorkerEvent,
  ): RuntimeRecoveryEventResult {
    if (event.type === "runtime.legacy-recovery-authority-consumed") {
      const platform = legacyRuntimeRecoveryPlatform();
      if (
        !platform
        || event.currentRuntimeGenerationId !== record.runtimeGenerationId
        || !record.legacyRecoveryAuthorityIds.has(
          event.retiredRuntimeGenerationId,
        )
        || !this.#legacyAuthorities.has(
          event.retiredRuntimeGenerationId,
          platform,
          this.#systemBootId,
        )
      ) return { handled: true };
      record.legacyRecoveryAuthorityIds.delete(
        event.retiredRuntimeGenerationId,
      );
      if (record.legacyRecoveryAuthorityIds.size > 0) {
        return { handled: true };
      }
      for (const runtimeGenerationId of
        record.legacyRecoveryAuthorityBatchIds) {
        if (!this.#legacyAuthorities.consume(
          runtimeGenerationId,
          platform,
          this.#systemBootId,
        )) return {
          handled: true,
          error:
            "The manual legacy runtime recovery authority could not be consumed safely.",
        };
      }
      return { handled: true };
    }

    const descriptor = record.modernDarwinRecoveryAuthority;
    const authority = this.#modernAuthorities.pending();
    if (
      !descriptor
      || event.currentRuntimeGenerationId !== record.runtimeGenerationId
      || event.operationId !== descriptor.operationId
      || event.snapshotDigest !== descriptor.snapshotDigest
      || !authority
      || !modernDarwinRecoveryDescriptorMatches(descriptor, authority)
      || !this.#modernAuthorities.beginRetirement(
        authority,
        this.#dataDirectory,
        record.runtimeGenerationId,
        { guardianPath: this.#guardianPath ?? "", platform: "darwin" },
      )
      || !this.#modernAuthorities.completeRetirement(
        this.#dataDirectory,
        authority,
      )
    ) return {
      handled: true,
      error: "The manual macOS runtime recovery could not be committed safely.",
    };
    record.modernDarwinRecoveryAuthority = null;
    this.#manualModernRecovery = null;
    return { handled: true };
  }

  #rollback(
    runtimeGenerationId: string,
    error: string,
  ): RuntimeRecoveryAdmissionFailure {
    this.#ownedProcesses.finishSession(runtimeGenerationId);
    this.#leases.consume(runtimeGenerationId);
    return { ok: false, error };
  }
}
