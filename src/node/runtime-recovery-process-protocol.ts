import { isAbsolute } from "node:path";

import { validRuntimeGenerationId, validSystemBootId } from
  "./runtime-identity-protocol.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ModernDarwinRecoveryAuthorityDescriptor {
  readonly operationId: string;
  readonly snapshotDigest: string;
  readonly runtimeGenerationIds: readonly string[];
}

export interface RuntimeRecoveryWorkerOptions {
  /** Main-resolved, packaged process guardian executable. */
  runtimeProcessGuardianPath?: string;
  /** User-authorized legacy leases; this does not assert process termination. */
  manuallyRetiredRuntimeGenerationIds?: readonly string[];
  /** Exact Darwin journal authority; surviving processes are never guessed. */
  manualModernDarwinRecovery?: ModernDarwinRecoveryAuthorityDescriptor;
  /** Main-owned quarantine after an earlier utility process exited unconfirmed. */
  priorRuntimeCleanupUnconfirmed?: true;
}

export type RuntimeRecoveryWorkerEvent =
  | {
      type: "runtime.legacy-recovery-authority-consumed";
      retiredRuntimeGenerationId: string;
      currentRuntimeGenerationId: string;
    }
  | {
      type: "runtime.modern-darwin-recovery-authority-acknowledged";
      operationId: string;
      snapshotDigest: string;
      currentRuntimeGenerationId: string;
    };

export interface ParsedRuntimeRecoveryWorkerOptions {
  readonly keyCount: number;
  readonly options: RuntimeRecoveryWorkerOptions;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.includes("\0")
    && isAbsolute(value);
}

export function parseRuntimeRecoveryWorkerOptions(
  options: Record<string, unknown>,
  currentRuntimeGenerationId: unknown,
  systemBootId: unknown,
  confirmedRuntimeGenerationIds: readonly unknown[],
): ParsedRuntimeRecoveryWorkerOptions | null {
  const hasGuardian = Object.hasOwn(options, "runtimeProcessGuardianPath");
  const hasLegacy = Object.hasOwn(
    options,
    "manuallyRetiredRuntimeGenerationIds",
  );
  const hasModern = Object.hasOwn(options, "manualModernDarwinRecovery");
  const hasUnconfirmed = Object.hasOwn(
    options,
    "priorRuntimeCleanupUnconfirmed",
  );
  if (
    !validRuntimeGenerationId(currentRuntimeGenerationId)
    || !validSystemBootId(systemBootId)
    || (hasGuardian && !runtimePath(options.runtimeProcessGuardianPath))
    || (hasUnconfirmed && options.priorRuntimeCleanupUnconfirmed !== true)
  ) return null;

  const legacyIds = hasLegacy
    && Array.isArray(options.manuallyRetiredRuntimeGenerationIds)
    ? options.manuallyRetiredRuntimeGenerationIds
    : null;
  if (
    hasLegacy
    && (
      !legacyIds
      || legacyIds.length < 1
      || legacyIds.length > 32
      || new Set(legacyIds).size !== legacyIds.length
      || legacyIds.some((generationId) => (
        !validRuntimeGenerationId(generationId)
        || generationId === currentRuntimeGenerationId
        || confirmedRuntimeGenerationIds.includes(generationId)
      ))
    )
  ) return null;

  const modern = hasModern && plainObject(options.manualModernDarwinRecovery)
    ? options.manualModernDarwinRecovery
    : null;
  const modernIds = modern && Array.isArray(modern.runtimeGenerationIds)
    ? modern.runtimeGenerationIds
    : null;
  if (
    hasModern
    && (
      !hasGuardian
      || systemBootId === "unavailable"
      || !modern
      || Object.keys(modern).length !== 3
      || typeof modern.operationId !== "string"
      || !UUID_PATTERN.test(modern.operationId)
      || typeof modern.snapshotDigest !== "string"
      || !SHA256_PATTERN.test(modern.snapshotDigest)
      || !modernIds
      || modernIds.length < 1
      || modernIds.length > 32
      || new Set(modernIds).size !== modernIds.length
      || modernIds.some((generationId) => (
        !validRuntimeGenerationId(generationId)
        || generationId === currentRuntimeGenerationId
        || confirmedRuntimeGenerationIds.includes(generationId)
        || (legacyIds?.includes(generationId) ?? false)
      ))
    )
  ) return null;

  return {
    keyCount: Number(hasGuardian) + Number(hasLegacy)
      + Number(hasModern) + Number(hasUnconfirmed),
    options: {
      ...(hasGuardian
        ? { runtimeProcessGuardianPath: options.runtimeProcessGuardianPath as string }
        : {}),
      ...(legacyIds
        ? { manuallyRetiredRuntimeGenerationIds: [...legacyIds] as string[] }
        : {}),
      ...(modern && modernIds
        ? {
            manualModernDarwinRecovery: {
              operationId: modern.operationId as string,
              snapshotDigest: modern.snapshotDigest as string,
              runtimeGenerationIds: [...modernIds] as string[],
            },
          }
        : {}),
      ...(hasUnconfirmed ? { priorRuntimeCleanupUnconfirmed: true } : {}),
    },
  };
}

export function parseRuntimeRecoveryWorkerEvent(
  value: Record<string, unknown>,
): RuntimeRecoveryWorkerEvent | null {
  if (
    value.type === "runtime.legacy-recovery-authority-consumed"
    && Object.keys(value).length === 3
    && validRuntimeGenerationId(value.retiredRuntimeGenerationId)
    && validRuntimeGenerationId(value.currentRuntimeGenerationId)
    && value.retiredRuntimeGenerationId !== value.currentRuntimeGenerationId
  ) return {
    type: value.type,
    retiredRuntimeGenerationId: value.retiredRuntimeGenerationId,
    currentRuntimeGenerationId: value.currentRuntimeGenerationId,
  };
  if (
    value.type === "runtime.modern-darwin-recovery-authority-acknowledged"
    && Object.keys(value).length === 4
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
    && typeof value.snapshotDigest === "string"
    && SHA256_PATTERN.test(value.snapshotDigest)
    && validRuntimeGenerationId(value.currentRuntimeGenerationId)
  ) return {
    type: value.type,
    operationId: value.operationId,
    snapshotDigest: value.snapshotDigest,
    currentRuntimeGenerationId: value.currentRuntimeGenerationId,
  };
  return null;
}
