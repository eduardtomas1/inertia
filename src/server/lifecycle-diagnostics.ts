import { createHash } from "node:crypto";

import type {
  ConversationShell,
  ProviderInfo,
  WorkspaceRun,
} from "../shared/contracts";
import type { ProviderMaintenanceDiagnosticState } from
  "../shared/provider-maintenance";
import {
  safeLifecycleProviderVersion,
  type RuntimeLifecycleDiagnosticSnapshot,
} from "../shared/lifecycle-diagnostics";
import { continuationRejectedForCompatibility } from
  "../shared/continuation-reason-codes";
import {
  embeddedLifecycleBuildMetadata,
  lifecycleBuildMetadataSchema,
  type LifecycleBuildMetadata,
} from "../shared/lifecycle-build-metadata";
import { currentKnownHarnessIdSchema } from "../shared/model-routing";

const MAX_REPORTED_RUNTIME_UPTIME_MS = 30 * 24 * 60 * 60 * 1_000;
export interface RuntimeLifecycleDiagnosticInput {
  runtimeGenerationId: string;
  systemBootId: string;
  runtimeStartedAt: string;
  runtimeSafetyLock: boolean;
  confirmedCleanupReceiptConsumed: boolean;
  providerInfo: readonly ProviderInfo[];
  conversations: readonly ConversationShell[];
  runs: readonly WorkspaceRun[];
  providerMaintenanceStates: readonly ProviderMaintenanceDiagnosticState[];
  providerMaintenanceRecoveryCount: number;
  selectedConversationId: string | null;
  activeConversationIds: readonly string[];
  runningProviderConversationIds: ReadonlySet<string>;
  providerRunOwnershipConversationIds: readonly string[];
  terminalOwnershipCount: number;
  interactionCount: number;
  buildMetadata?: LifecycleBuildMetadata | null;
  capturedAt?: Date;
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.trunc(value), 1_000_000));
}

function providerMaintenanceState(
  providerId: ProviderInfo["id"],
  states: readonly ProviderMaintenanceDiagnosticState[],
): RuntimeLifecycleDiagnosticSnapshot["activeProviders"][number]["maintenanceState"] {
  return states.find((candidate) => candidate.providerId === providerId)?.state
    ?? "idle";
}

export function runtimeLifecycleDiagnosticSnapshot(
  input: RuntimeLifecycleDiagnosticInput,
): RuntimeLifecycleDiagnosticSnapshot {
  const capturedAt = input.capturedAt ?? new Date();
  const capturedTime = capturedAt.getTime();
  const startedTime = Date.parse(input.runtimeStartedAt);
  const runtimeStartedAt = Number.isFinite(startedTime)
    ? new Date(startedTime).toISOString()
    : null;
  const suppliedBuildMetadata = input.buildMetadata === undefined
    ? embeddedLifecycleBuildMetadata()
    : input.buildMetadata;
  const parsedBuildMetadata = lifecycleBuildMetadataSchema.safeParse(
    suppliedBuildMetadata,
  );
  const activeConversationIds = new Set(input.activeConversationIds);
  const activeProviders = [
    ...new Map(
      input.conversations
        .filter(({ id }) => activeConversationIds.has(id))
        .flatMap((conversation) => {
          const parsedHarness = currentKnownHarnessIdSchema.safeParse(
            conversation.modelSelection.harnessId,
          );
          if (!parsedHarness.success) return [];
          const harnessId = parsedHarness.data;
          const provider = input.providerInfo.find(
            ({ id }) => id === conversation.providerId,
          );
          const contract =
            provider?.capabilityContract?.harnessId === harnessId
              ? provider.capabilityContract
              : undefined;
          const diagnostic = {
            providerId: conversation.providerId,
            harnessId,
            version: safeLifecycleProviderVersion(provider?.version ?? null),
            capabilityManifestDigest: contract?.manifestDigest.match(
              /^[0-9a-f]{64}$/u,
            )
              ? contract.manifestDigest
              : null,
            installationVerified: contract?.installationVerified === true,
            maintenanceState: providerMaintenanceState(
              conversation.providerId,
              input.providerMaintenanceStates,
            ),
          } satisfies RuntimeLifecycleDiagnosticSnapshot["activeProviders"][number];
          return [
            [
              `${diagnostic.providerId}:${diagnostic.harnessId}`,
              diagnostic,
            ] as const,
          ];
        }),
    ).values(),
  ].sort(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) ||
      left.harnessId.localeCompare(right.harnessId),
  );
  const activeWorkspaceRuns = input.runs.filter(
    ({ status }) => status === "running" || status === "waiting",
  ).length;
  const activeMaintenance = input.providerMaintenanceStates.filter(
    ({ state }) =>
      state === "queued" || state === "running" || state === "verifying",
  ).length;
  const quarantinedMaintenance = input.providerMaintenanceStates.filter(
    ({ state }) => state === "quarantined",
  ).length;
  const providerMaintenanceRecoveryCount = boundedCount(
    input.providerMaintenanceRecoveryCount,
  );
  const maintenanceRecoveryRequired = providerMaintenanceRecoveryCount > 0;
  const maintenanceQuarantined = quarantinedMaintenance > 0;
  const selectedContinuationReason = input.conversations.find(
    ({ id }) => id === input.selectedConversationId,
  )?.latestTurn?.continuationReasonCode ?? null;
  const providerInstallationChanged = selectedContinuationReason
    === "provider-installation-changed";
  const sessionResumeRejected = continuationRejectedForCompatibility(
    selectedContinuationReason,
  );
  const providerRunOwnershipConversationIds =
    input.providerRunOwnershipConversationIds;
  const providerRunOwnershipIds = new Set(
    providerRunOwnershipConversationIds,
  );
  const cleanupPending =
    providerRunOwnershipIds.size !== providerRunOwnershipConversationIds.length
    || providerRunOwnershipIds.size
      !== input.runningProviderConversationIds.size
    || [...providerRunOwnershipIds].some(
      (conversationId) => !input.runningProviderConversationIds.has(
        conversationId,
      ),
    );
  const startupBlockerCodes: RuntimeLifecycleDiagnosticSnapshot["startupBlockerCodes"] =
    [];
  if (input.runtimeSafetyLock) {
    startupBlockerCodes.push("prior-runtime-cleanup-unconfirmed");
  }
  if (cleanupPending) startupBlockerCodes.push("provider-cleanup-pending");
  if (maintenanceRecoveryRequired || maintenanceQuarantined) {
    startupBlockerCodes.push("provider-installation-quarantined");
  }
  if (activeMaintenance > 0) startupBlockerCodes.push("maintenance-active");

  const actionableState: RuntimeLifecycleDiagnosticSnapshot["actionableState"] =
    input.runtimeSafetyLock
      ? "previous-runtime-cleanup-unconfirmed"
      : maintenanceRecoveryRequired || maintenanceQuarantined
        ? "recovery-requires-manual-attention"
        : cleanupPending
          ? "waiting-for-provider-cleanup"
          : activeMaintenance > 0
            ? "finishing-previous-work"
            : providerInstallationChanged
              ? "provider-installation-changed"
              : sessionResumeRejected
                ? "session-resume-rejected-for-compatibility"
                : activeProviders.some(
                      ({ installationVerified }) => !installationVerified,
                    )
                  ? "provider-capability-unavailable"
                  : "safe-and-ready";

  return {
    schemaVersion: 1,
    capturedAt: capturedAt.toISOString(),
    runtimeStartedAt,
    runtimeUptimeMs: boundedCount(
      runtimeStartedAt === null ? 0 : Math.min(
        Math.max(0, capturedTime - startedTime),
        MAX_REPORTED_RUNTIME_UPTIME_MS,
      ),
    ),
    runtimeGenerationHash: createHash("sha256")
      .update(input.runtimeGenerationId)
      .digest("hex")
      .slice(0, 12),
    buildMetadata: parsedBuildMetadata.success
      ? parsedBuildMetadata.data
      : null,
    systemBootRelationship:
      input.systemBootId === "unavailable"
        ? "unavailable"
        : input.runtimeSafetyLock
          ? "unresolved"
          : "current",
    startupBlockerCodes,
    quarantineReason: input.runtimeSafetyLock
      ? "prior-runtime-cleanup-unconfirmed"
      : maintenanceRecoveryRequired
        ? "provider-maintenance-recovery-required"
        : maintenanceQuarantined
          ? "provider-maintenance-quarantined"
          : providerInstallationChanged
            ? "provider-installation-changed"
            : null,
    cleanupProofMethod: input.runtimeSafetyLock
      ? "unconfirmed"
      : input.confirmedCleanupReceiptConsumed
        ? "confirmed-cleanup-receipt"
        : "current-generation-lease",
    ownedResources: {
      providerRuns: boundedCount(providerRunOwnershipConversationIds.length),
      turns: boundedCount(activeConversationIds.size),
      terminals: boundedCount(input.terminalOwnershipCount),
      workspaceRuns: boundedCount(activeWorkspaceRuns),
      interactions: boundedCount(input.interactionCount),
      maintenanceOperations: boundedCount(
        activeMaintenance
          + quarantinedMaintenance
          + providerMaintenanceRecoveryCount,
      ),
    },
    activeProviders,
    providerMaintenance: input.providerMaintenanceStates.slice(0, 5).map(
      ({ providerId, state }) => ({ providerId, state }),
    ),
    updateHandoffPhase: null,
    unresolvedTurnCount: boundedCount(activeConversationIds.size),
    unresolvedInteractionCount: boundedCount(input.interactionCount),
    actionableState,
  };
}
