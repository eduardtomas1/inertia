import type { RuntimeSupervisorSnapshot } from "./runtime-supervisor.js";
import type { RuntimeLifecycleDiagnosticSnapshot } from "../shared/lifecycle-diagnostics.js";
import type { AppUpdateHandoffDiagnostic } from "./app-update-handoff.js";
import {
  isAppUpdatePreparationDiagnostic,
  lifecycleActionableStateWithUpdate,
  type AppUpdatePreparationDiagnostic,
} from "../shared/app-update-preparation-diagnostic.js";
import {
  lifecycleBuildMetadataSchema,
  type LifecycleBuildMetadata,
} from "../shared/lifecycle-build-metadata.js";
import { sanitizeRuntimeDiagnosticText } from "./runtime-diagnostic-records.js";

export interface RuntimeSupportReportInput {
  version: string;
  channel?: "stable" | "canary";
  platform: string;
  architecture: string;
  runtime: RuntimeSupervisorSnapshot | null;
  lifecycle?: RuntimeLifecycleDiagnosticSnapshot | null;
  updateHandoff?: AppUpdateHandoffDiagnostic | null;
  updatePreparation?: AppUpdatePreparationDiagnostic | null;
  buildMetadata?: LifecycleBuildMetadata | null;
}

export interface RuntimeSupportReport {
  text: string;
  eventCount: number;
}

export function renderSupportSummary(
  input: RuntimeSupportReportInput,
  recentEvents: readonly string[],
  generatedAt: number,
): RuntimeSupportReport {
  const events = recentEvents.slice(-120);
  const runtime = input.runtime;
  const submittedLifecycle = input.lifecycle ?? null;
  const lifecycle = runtime?.phase === "ready"
    && runtime.runtimeGenerationHash !== null
    && submittedLifecycle?.runtimeGenerationHash
      === runtime.runtimeGenerationHash
    ? submittedLifecycle
    : null;
  const updatePreparation = isAppUpdatePreparationDiagnostic(
    input.updatePreparation,
  )
    ? input.updatePreparation
    : null;
  const lifecycleState = lifecycle
    ? lifecycleActionableStateWithUpdate(
        lifecycle.actionableState,
        updatePreparation,
      )
    : null;
  const buildMetadataCandidate = input.buildMetadata === undefined
    ? lifecycle?.buildMetadata ?? null
    : input.buildMetadata;
  const parsedBuildMetadata = lifecycleBuildMetadataSchema.safeParse(
    buildMetadataCandidate,
  );
  const buildMetadata = parsedBuildMetadata.success
    ? parsedBuildMetadata.data
    : null;
  const updateHandoffPhase = input.updateHandoff?.state === "none"
    ? lifecycle?.updateHandoffPhase ?? "none"
    : input.updateHandoff?.phase ?? lifecycle?.updateHandoffPhase ?? "unavailable";
  const startupBlockerCode = runtime?.startupBlockerCode ?? null;
  const lifecycleLines = lifecycle
    ? [
        `Lifecycle state: ${lifecycleState}`,
        `Runtime generation hash: ${lifecycle.runtimeGenerationHash}`,
        `System boot relationship: ${lifecycle.systemBootRelationship}`,
        `Startup blockers: ${lifecycle.startupBlockerCodes.join(", ") || "none"}`,
        `Quarantine reason: ${lifecycle.quarantineReason ?? "none"}`,
        `Cleanup proof: ${lifecycle.cleanupProofMethod}`,
        `Owned resources: provider-runs=${lifecycle.ownedResources.providerRuns}, turns=${lifecycle.ownedResources.turns}, terminals=${lifecycle.ownedResources.terminals}, workspace-runs=${lifecycle.ownedResources.workspaceRuns}, interactions=${lifecycle.ownedResources.interactions}, maintenance=${lifecycle.ownedResources.maintenanceOperations}`,
        `Unresolved: turns=${lifecycle.unresolvedTurnCount}, interactions=${lifecycle.unresolvedInteractionCount}`,
        `Active providers: ${lifecycle.activeProviders.length > 0
          ? lifecycle.activeProviders.map((provider) => (
              `${provider.providerId}/${provider.harnessId}@${provider.version ?? "unknown"}`
              + ` manifest=${provider.capabilityManifestDigest ?? "unverified"}`
              + ` verified=${provider.installationVerified ? "yes" : "no"}`
              + ` maintenance=${provider.maintenanceState}`
            )).join(", ")
          : "none"}`,
        `Provider maintenance: ${lifecycle.providerMaintenance.length > 0
          ? lifecycle.providerMaintenance.map(
              ({ providerId, state }) => `${providerId}=${state}`,
            ).join(", ")
          : "none"}`,
        `Runtime lifecycle started: ${lifecycle.runtimeStartedAt ?? "unavailable"}`,
        `Runtime lifecycle captured: ${lifecycle.capturedAt}`,
        `Runtime lifecycle uptime: ${lifecycle.runtimeUptimeMs}ms`,
      ]
    : startupBlockerCode
      ? [
          `Lifecycle state: ${startupBlockerCode === "prior-runtime-cleanup-unconfirmed"
            ? "previous-runtime-cleanup-unconfirmed"
            : "recovery-requires-manual-attention"}`,
          `Startup blockers: ${startupBlockerCode}`,
          `Quarantine reason: ${startupBlockerCode === "prior-runtime-cleanup-unconfirmed"
            ? "prior-runtime-cleanup-unconfirmed"
            : "provider-maintenance-recovery-required"}`,
          `Cleanup proof: ${startupBlockerCode === "prior-runtime-cleanup-unconfirmed"
            ? "unconfirmed"
            : "unavailable"}`,
        ]
      : ["Lifecycle state: unavailable"];
  const preface = [
    "Inertia support summary",
    `Generated: ${new Date(generatedAt).toISOString()}`,
    `Version: ${sanitizeRuntimeDiagnosticText(input.version) ?? "unknown"}`,
    `Channel: ${input.channel ?? "stable"}`,
    `Platform: ${sanitizeRuntimeDiagnosticText(input.platform) ?? "unknown"}`,
    `Architecture: ${sanitizeRuntimeDiagnosticText(input.architecture) ?? "unknown"}`,
    `Runtime: ${runtime?.phase ?? "unavailable"}`,
    `Runtime generation: ${runtime?.generation ?? 0}`,
    `Restart attempt: ${runtime?.restartAttempt ?? 0}`,
    `Restart scheduled: ${runtime?.restartScheduled === true ? "yes" : "no"}`,
    `Build metadata: ${buildMetadata
      ? `${buildMetadata.source} revision=${buildMetadata.sourceRevision} run=${buildMetadata.runId} attempt=${buildMetadata.runAttempt} release=${buildMetadata.releaseTag ?? "none"}`
      : "unavailable"}`,
    ...lifecycleLines,
    `Update preparation: ${updatePreparation?.phase ?? "unavailable"}${
      updatePreparation?.blocker
        ? ` blocker=${updatePreparation.blocker}`
        : ""
    }`,
    `Update handoff: ${updateHandoffPhase}`,
    "",
  ];
  const footer = [
    "Privacy: prompts, source, project paths, token values, credentials, connection capabilities, and provider output are excluded.",
  ];
  const render = (selected: string[]): string => [
    ...preface,
    selected.length === events.length
      ? `Recent lifecycle events (${selected.length}):`
      : `Recent lifecycle events (${selected.length} of ${events.length} copied):`,
    ...(selected.length > 0 ? selected : ["No lifecycle events recorded."]),
    "",
    ...footer,
  ].join("\n");
  let selected: string[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = [events[index]!, ...selected];
    if (Buffer.byteLength(render(candidate), "utf8") > 64 * 1_024) break;
    selected = candidate;
  }
  return {
    text: render(selected),
    eventCount: selected.length,
  };
}
