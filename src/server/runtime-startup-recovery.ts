import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { RuntimeGenerationLeaseJournal } from
  "../node/runtime-generation-leases.js";
import { ConversationAttachmentStore } from
  "../node/conversation-attachment-store.js";
import { validRuntimeGenerationId, validSystemBootId } from
  "../node/runtime-identity-protocol.js";
import {
  modernDarwinRecoveryDescriptorMatches,
  modernDarwinRecoveryJournalMatches,
  ModernDarwinRecoveryAuthorityJournal,
  type ModernDarwinRecoveryAuthorityDescriptor,
} from "../node/runtime-modern-recovery-authorities.js";
import type { RuntimeOptions } from "./runtime-types.js";
import { RuntimeStore } from "./database.js";
import { reconcileInterruptedDuoLaunches } from
  "./runtime/duo/duo-launch-coordinator.js";
import { recoverInterruptedTurns } from
  "./runtime/turns/turn-recovery.js";
import { ProviderMaintenanceJournal } from "./provider/maintenance-journal.js";
import { OrchestrationEffectRuntime } from "./orchestration-v2/effect-runtime.js";
import { RuntimeStartupBlockerError } from "../shared/runtime-startup-diagnostics.js";
import { createIncidentReporter } from "../node/application-incidents.js";

export interface RuntimeStartupRecovery {
  readonly dataDirectory: string;
  readonly runtimeGenerationLeases: RuntimeGenerationLeaseJournal;
  readonly confirmedGenerations: readonly string[];
  readonly manuallyRetiredGenerations: readonly string[];
  readonly manualModernDarwinRecovery:
    ModernDarwinRecoveryAuthorityDescriptor | undefined;
  readonly authorizedModernGenerationIds: ReadonlySet<string>;
  readonly exitedUnconfirmedGenerations: readonly string[];
  readonly priorBootLeasesCleared: boolean;
  readonly runtimeSafetyLock: boolean;
}

export interface InitializedRuntimePersistence {
  readonly conversationAttachments: ConversationAttachmentStore;
  readonly recovery: ReturnType<typeof recoverInterruptedTurns>;
  readonly providerMaintenanceJournal: ProviderMaintenanceJournal;
  readonly orchestrationEffects: OrchestrationEffectRuntime;
}

export async function initializeRuntimePersistence(
  options: RuntimeOptions,
  startup: RuntimeStartupRecovery,
  store: RuntimeStore,
): Promise<InitializedRuntimePersistence> {
  const {
    dataDirectory,
    runtimeGenerationLeases,
    confirmedGenerations,
    manuallyRetiredGenerations,
    manualModernDarwinRecovery,
    authorizedModernGenerationIds,
    exitedUnconfirmedGenerations,
    priorBootLeasesCleared,
    runtimeSafetyLock,
  } = startup;
  let conversationAttachments: ConversationAttachmentStore | null = null;
  let orchestrationEffects: OrchestrationEffectRuntime | null = null;
  try {
    const providerMaintenanceJournal = new ProviderMaintenanceJournal(dataDirectory, {
      runtimeGenerationId: options.runtimeGenerationId,
      systemBootId: options.systemBootId,
    });
    for (const generationId of confirmedGenerations) {
      store.providerRunOwnership.clearRuntimeGeneration(generationId);
    }
    for (const generationId of manuallyRetiredGenerations) {
      store.providerRunOwnership.clearRuntimeGeneration(generationId);
    }
    for (const generationId of authorizedModernGenerationIds) {
      store.providerRunOwnership.clearRuntimeGeneration(generationId);
    }
    if (priorBootLeasesCleared) {
      store.providerRunOwnership.clearPriorBootSessions(options.systemBootId);
    }
    if (!runtimeSafetyLock) {
      for (const generationId of exitedUnconfirmedGenerations) {
        store.providerRunOwnership.clearRuntimeGeneration(generationId);
      }
    }
    const testRecordLimit = process.env.NODE_ENV === "test"
      ? Number(process.env.INERTIA_TEST_CONVERSATION_ATTACHMENT_MAX_RECORDS ?? 0)
      : 0;
    const attachmentSettings = store.shellSnapshot().settings;
    conversationAttachments = await ConversationAttachmentStore.open(
      dataDirectory,
      {
        maxBytes: attachmentSettings.attachmentStorageGiB * 1024 ** 3,
        autoRemoveOldAttachments: attachmentSettings.autoRemoveOldAttachments,
        ...(testRecordLimit > 0 ? { maxRecords: testRecordLimit, autoRemoveOldAttachments: true } : {}),
        ...(options.conversationAttachmentStoreOperations
          ? {
              operationRunner: options.conversationAttachmentStoreOperations,
              readOperationRunner: options.conversationAttachmentStoreOperations,
            }
          : {}),
      },
    );
    if (!runtimeSafetyLock) {
      await conversationAttachments.reconcile(store.attachments());
      if (manuallyRetiredGenerations.length > 0
        && process.env.NODE_ENV === "test") {
        options.testOnlyBeforeLegacyInterruptedRecovery?.();
      }
      if (authorizedModernGenerationIds.size > 0
        && process.env.NODE_ENV === "test") {
        options.testOnlyBeforeModernDarwinRecoveryAcknowledged?.();
      }
    }
    const recovery = runtimeSafetyLock
      ? { recoveredTurns: [], recoveredAttachmentIds: [] }
      : recoverInterruptedTurns(store);
    if (!runtimeSafetyLock) {
      store.orchestration.nativeControls.reconcileCleanup({
        confirmedRuntimeGenerationIds: new Set([...confirmedGenerations, ...manuallyRetiredGenerations, ...authorizedModernGenerationIds]),
        currentSystemBootId: options.systemBootId, priorBootCleanupConfirmed: priorBootLeasesCleared,
      });
      for (const generationId of manuallyRetiredGenerations) {
        if (!runtimeGenerationLeases.clearUnavailableRuntimeGeneration(
          generationId,
        )) {
          throw new Error("Manual legacy provider ownership could not be retired.");
        }
      }
      await reconcileInterruptedDuoLaunches(store);
      store.watcherLinks.recoverInterruptedWakes(new Date().toISOString());
      try {
        providerMaintenanceJournal.reconcile({
          confirmedRuntimeGenerationIds: new Set([
            ...confirmedGenerations,
            ...manuallyRetiredGenerations,
            ...authorizedModernGenerationIds,
          ]),
          currentSystemBootId: options.systemBootId,
          priorBootCleanupConfirmed: priorBootLeasesCleared,
        });
      } catch {
        throw new RuntimeStartupBlockerError(
          "provider-installation-quarantined",
          "Provider maintenance cleanup proof could not be preserved safely.",
        );
      }
      // Recovery receipts reset the supervisor's one fresh readiness window.
      // Emit them only after every mandatory startup reconciliation succeeds;
      // otherwise remaining recovery work would consume that second phase.
      for (const generationId of confirmedGenerations) {
        options.onCleanupReceiptConsumed?.(
          generationId,
          options.runtimeGenerationId,
        );
      }
      for (const generationId of manuallyRetiredGenerations) {
        options.onLegacyRecoveryAuthorityConsumed?.(
          generationId,
          options.runtimeGenerationId,
        );
      }
      if (manualModernDarwinRecovery) {
        options.onModernDarwinRecoveryAuthorityAcknowledged?.(
          manualModernDarwinRecovery,
          options.runtimeGenerationId,
        );
      }
      if (exitedUnconfirmedGenerations.length > 0) {
        createIncidentReporter(options.onIncident, options.runtimeGenerationId)({
          code: "runtime.cleanup-unconfirmed", outcome: "unknown",
        });
      }
    }
    orchestrationEffects = new OrchestrationEffectRuntime(store.orchestration.effects);
    if (!runtimeSafetyLock) orchestrationEffects.start();
    return { conversationAttachments, recovery, providerMaintenanceJournal, orchestrationEffects };
  } catch (error) {
    // Release every acquired persistent resource on startup failure. Windows
    // otherwise retains SQLite handles and a retry appears to require reboot.
    await orchestrationEffects?.stop();
    await Promise.allSettled([
      conversationAttachments?.close(),
      Promise.resolve().then(() => store.backupAndClose()),
    ]);
    throw error;
  }
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
  const exitedUnconfirmedGenerations =
    options.exitedUnconfirmedRuntimeGenerationIds ?? [];
  if (
    exitedUnconfirmedGenerations.length > 32
    || new Set(exitedUnconfirmedGenerations).size
      !== exitedUnconfirmedGenerations.length
    || exitedUnconfirmedGenerations.some((generationId) => (
      !validRuntimeGenerationId(generationId)
      || generationId === options.runtimeGenerationId
      || confirmedGenerations.includes(generationId)
      || manuallyRetiredGenerations.includes(generationId)
    ))
  ) throw new Error("The exited runtime generations are invalid.");

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

  const authorizedLegacyGenerationIds = new Set(manuallyRetiredGenerations);
  const authorizedModernGenerationIds = new Set(
    manualModernDarwinRecovery?.runtimeGenerationIds ?? [],
  );
  const priorBootLeasesCleared = runtimeGenerationLeases.clearPriorBootSessions(
    options.systemBootId,
    authorizedModernGenerationIds,
  );
  const retainedGenerationLeases = runtimeGenerationLeases.all();
  const currentGenerationOwner = (
    lease: typeof retainedGenerationLeases[number],
  ): boolean => lease.runtimeGenerationId === options.runtimeGenerationId
    && lease.systemBootId === options.systemBootId;
  const exitedGenerationIds = new Set(exitedUnconfirmedGenerations);
  const runtimeSafetyLock = options.priorRuntimeCleanupUnconfirmed === true
    || !runtimeGenerationLeases.isValid()
    || !retainedGenerationLeases.some(currentGenerationOwner)
    || retainedGenerationLeases.some((lease) => (
      !currentGenerationOwner(lease)
      && !(lease.systemBootId === "unavailable"
        && authorizedLegacyGenerationIds.has(lease.runtimeGenerationId))
      && !authorizedModernGenerationIds.has(lease.runtimeGenerationId)
      && !(lease.systemBootId === options.systemBootId
        && exitedGenerationIds.has(lease.runtimeGenerationId))
    ));
  return {
    dataDirectory,
    runtimeGenerationLeases,
    confirmedGenerations,
    manuallyRetiredGenerations,
    manualModernDarwinRecovery,
    authorizedModernGenerationIds,
    exitedUnconfirmedGenerations,
    priorBootLeasesCleared,
    runtimeSafetyLock,
  };
}
