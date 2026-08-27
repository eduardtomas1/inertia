import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { RuntimeGenerationLeaseJournal } from
  "../node/runtime-generation-leases.js";
import { validRuntimeGenerationId, validSystemBootId } from
  "../node/runtime-identity-protocol.js";
import {
  modernDarwinRecoveryDescriptorMatches,
  modernDarwinRecoveryJournalMatches,
  ModernDarwinRecoveryAuthorityJournal,
  type ModernDarwinRecoveryAuthorityDescriptor,
} from "../node/runtime-modern-recovery-authorities.js";
import type { RuntimeOptions } from "./runtime-types.js";

export interface RuntimeStartupRecovery {
  readonly dataDirectory: string;
  readonly runtimeGenerationLeases: RuntimeGenerationLeaseJournal;
  readonly confirmedGenerations: readonly string[];
  readonly manuallyRetiredGenerations: readonly string[];
  readonly manualModernDarwinRecovery:
    ModernDarwinRecoveryAuthorityDescriptor | undefined;
  readonly authorizedModernGenerationIds: ReadonlySet<string>;
  readonly priorBootLeasesCleared: boolean;
  readonly runtimeSafetyLock: boolean;
}

export function runtimeSafetyError(operation: string): string {
  return `${operation} A prior runtime-owned process may still be running. Inertia kept the affected work unchanged and will retry exact cleanup when its local service starts again; contact support if the recovery remains blocked.`;
}

export function prepareRuntimeStartupRecovery(
  options: RuntimeOptions,
): RuntimeStartupRecovery {
  if (!validRuntimeGenerationId(options.runtimeGenerationId)) {
    throw new Error("The runtime generation identity is invalid.");
  }
  if (!validSystemBootId(options.systemBootId)) {
    throw new Error("The operating system boot identity is invalid.");
  }
  const confirmedGenerations =
    options.confirmedTerminatedRuntimeGenerationIds ?? [];
  const manuallyRetiredGenerations =
    options.manuallyRetiredRuntimeGenerationIds ?? [];
  const manualModernDarwinRecovery = options.manualModernDarwinRecovery;
  if (
    confirmedGenerations.length > 32
    || new Set(confirmedGenerations).size !== confirmedGenerations.length
    || confirmedGenerations.some((generationId) => (
      !validRuntimeGenerationId(generationId)
      || generationId === options.runtimeGenerationId
    ))
  ) throw new Error("The confirmed runtime cleanup receipts are invalid.");
  if (
    manuallyRetiredGenerations.length > 32
    || new Set(manuallyRetiredGenerations).size
      !== manuallyRetiredGenerations.length
    || manuallyRetiredGenerations.some((generationId) => (
      !validRuntimeGenerationId(generationId)
      || generationId === options.runtimeGenerationId
      || confirmedGenerations.includes(generationId)
    ))
  ) throw new Error("The manual legacy runtime recovery authorities are invalid.");

  const dataDirectory = resolve(options.dataDirectory);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const runtimeGenerationLeases = new RuntimeGenerationLeaseJournal(
    dataDirectory,
  );
  const modernDarwinAuthority = manualModernDarwinRecovery
    ? new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending()
    : null;
  if (
    manualModernDarwinRecovery
    && (
      !modernDarwinAuthority
      || modernDarwinAuthority.snapshot.systemBootId !== options.systemBootId
      || !modernDarwinRecoveryDescriptorMatches(
        manualModernDarwinRecovery,
        modernDarwinAuthority,
      )
      || !modernDarwinRecoveryJournalMatches(
        dataDirectory,
        modernDarwinAuthority,
        options.runtimeGenerationId,
      )
    )
  ) throw new Error("The manual macOS runtime recovery authority changed.");

  for (const generationId of confirmedGenerations) {
    if (!runtimeGenerationLeases.clearRuntimeGeneration(generationId)) {
      throw new Error("Confirmed provider process ownership could not be retired.");
    }
  }
  runtimeGenerationLeases.refresh();
  for (const generationId of manuallyRetiredGenerations) {
    const lease = runtimeGenerationLeases.all().find((candidate) =>
      candidate.runtimeGenerationId === generationId);
    if (lease && lease.systemBootId !== "unavailable") {
      throw new Error("Manual legacy recovery cannot retire a modern runtime lease.");
    }
  }

  const priorBootLeasesCleared = runtimeGenerationLeases.clearPriorBootSessions(
    options.systemBootId,
  );
  const retainedGenerationLeases = runtimeGenerationLeases.all();
  const currentGenerationOwner = (
    lease: typeof retainedGenerationLeases[number],
  ): boolean => lease.runtimeGenerationId === options.runtimeGenerationId
    && lease.systemBootId === options.systemBootId;
  const authorizedLegacyGenerationIds = new Set(manuallyRetiredGenerations);
  const authorizedModernGenerationIds = new Set(
    manualModernDarwinRecovery?.runtimeGenerationIds ?? [],
  );
  const runtimeSafetyLock = options.priorRuntimeCleanupUnconfirmed === true
    || !runtimeGenerationLeases.isValid()
    || !retainedGenerationLeases.some(currentGenerationOwner)
    || retainedGenerationLeases.some((lease) => (
      !currentGenerationOwner(lease)
      && !(lease.systemBootId === "unavailable"
        && authorizedLegacyGenerationIds.has(lease.runtimeGenerationId))
      && !authorizedModernGenerationIds.has(lease.runtimeGenerationId)
    ));
  return {
    dataDirectory,
    runtimeGenerationLeases,
    confirmedGenerations,
    manuallyRetiredGenerations,
    manualModernDarwinRecovery,
    authorizedModernGenerationIds,
    priorBootLeasesCleared,
    runtimeSafetyLock,
  };
}
