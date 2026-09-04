import { z } from "zod";

import { knownHarnessIdSchema } from "./model-routing";
import { providerMaintenanceProviderIdSchema } from "./provider-maintenance";
import { lifecycleBuildMetadataSchema } from "./lifecycle-build-metadata";

export const LIFECYCLE_ACTIONABLE_STATES = [
  "safe-and-ready",
  "finishing-previous-work",
  "waiting-for-provider-cleanup",
  "update-blocked-by-active-work",
  "previous-runtime-cleanup-unconfirmed",
  "provider-installation-changed",
  "session-resume-rejected-for-compatibility",
  "provider-capability-unavailable",
  "recovery-requires-manual-attention",
] as const;

export const APP_UPDATE_HANDOFF_PHASES = [
  "prepared",
  "candidate-launched",
  "candidate-bootstrap-validated",
  "old-generation-cleanup-confirmed",
  "ownership-transfer-committed",
  "candidate-admitted",
  "completed",
  "rollback-required",
  "rollback-completed",
] as const;

const boundedCount = z.number().int().min(0).max(1_000_000);
const safeVersion = z
  .string()
  .min(1)
  .max(96)
  .regex(/^v?\d{1,10}\.\d{1,10}(?:\.\d{1,10})?(?:[-+][0-9A-Za-z.-]{1,64})?$/u);

const lifecycleOwnedResourceCountsSchema = z
  .object({
    providerRuns: boundedCount,
    turns: boundedCount,
    terminals: boundedCount,
    workspaceRuns: boundedCount,
    interactions: boundedCount,
    maintenanceOperations: boundedCount,
  })
  .strict();

const lifecycleActiveProviderSchema = z
  .object({
    providerId: providerMaintenanceProviderIdSchema,
    harnessId: knownHarnessIdSchema,
    version: safeVersion.nullable(),
    capabilityManifestDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    installationVerified: z.boolean(),
    maintenanceState: z.enum([
      "idle",
      "queued",
      "running",
      "verifying",
      "quarantined",
    ]),
  })
  .strict();

const providerMaintenanceDiagnosticStateSchema = z
  .object({
    providerId: providerMaintenanceProviderIdSchema,
    state: z.enum([
      "idle",
      "queued",
      "running",
      "verifying",
      "quarantined",
    ]),
  })
  .strict();

/**
 * Renderer-safe lifecycle projection. It is deliberately code- and count-only:
 * no IDs, paths, prompts, provider output, environment, or arbitrary errors
 * cross this boundary. The desktop validates it again before an issue report.
 */
export const runtimeLifecycleDiagnosticSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: z.iso.datetime(),
    runtimeStartedAt: z.iso.datetime().nullable(),
    runtimeUptimeMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60 * 60 * 1_000),
    runtimeGenerationHash: z.string().regex(/^[0-9a-f]{12}$/u),
    buildMetadata: lifecycleBuildMetadataSchema.nullable(),
    systemBootRelationship: z.enum(["current", "unresolved", "unavailable"]),
    startupBlockerCodes: z
      .array(
        z.enum([
          "prior-runtime-cleanup-unconfirmed",
          "provider-cleanup-pending",
          "provider-installation-quarantined",
          "maintenance-active",
        ]),
      )
      .max(8),
    quarantineReason: z
      .enum([
        "prior-runtime-cleanup-unconfirmed",
        "provider-installation-changed",
        "provider-use-cleanup-unconfirmed",
        "maintenance-cleanup-unconfirmed",
        "provider-maintenance-recovery-required",
        "provider-maintenance-quarantined",
      ])
      .nullable(),
    cleanupProofMethod: z.enum([
      "current-generation-lease",
      "confirmed-cleanup-receipt",
      "unconfirmed",
    ]),
    ownedResources: lifecycleOwnedResourceCountsSchema,
    activeProviders: z.array(lifecycleActiveProviderSchema).max(5),
    providerMaintenance: z
      .array(providerMaintenanceDiagnosticStateSchema)
      .max(5),
    updateHandoffPhase: z.enum(APP_UPDATE_HANDOFF_PHASES).nullable(),
    unresolvedTurnCount: boundedCount,
    unresolvedInteractionCount: boundedCount,
    actionableState: z.enum(LIFECYCLE_ACTIONABLE_STATES),
  })
  .strict();

export type RuntimeLifecycleDiagnosticSnapshot = z.infer<
  typeof runtimeLifecycleDiagnosticSnapshotSchema
>;

export function parseRuntimeLifecycleDiagnosticSnapshot(
  value: unknown,
): RuntimeLifecycleDiagnosticSnapshot | null {
  const parsed = runtimeLifecycleDiagnosticSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function safeLifecycleProviderVersion(
  value: string | null,
): string | null {
  const parsed = safeVersion.safeParse(value);
  return parsed.success ? parsed.data : null;
}
