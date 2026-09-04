import { z } from "zod";

export const PROVIDER_MAINTENANCE_PROVIDER_IDS = [
  "codex",
  "claude",
  "cursor",
  "gemini",
  "kimi",
  "opencode",
] as const;

export const providerMaintenanceProviderIdSchema = z.enum(
  PROVIDER_MAINTENANCE_PROVIDER_IDS,
);

export type ProviderMaintenanceProviderId =
  (typeof PROVIDER_MAINTENANCE_PROVIDER_IDS)[number];

export type ProviderMaintenanceInstallMethod =
  | "provider-managed"
  | "npm-global"
  | "homebrew"
  | "manual"
  | "unknown";

export type ProviderMaintenanceVersionStatus =
  | "checking"
  | "current"
  | "update-available"
  | "unknown"
  | "not-installed";

export type ProviderMaintenanceFreshness =
  | "fresh"
  | "stale"
  | "unavailable";

export type ProviderMaintenanceUpdateAvailability =
  | "available"
  | "instructions-only"
  | "unavailable";

/**
 * Renderer-safe maintenance advisory. Executable paths, argv and lock keys are
 * intentionally private to the runtime.
 */
export interface ProviderMaintenanceStatus {
  providerId: ProviderMaintenanceProviderId;
  installedVersion: string | null;
  latestVersion: string | null;
  versionStatus: ProviderMaintenanceVersionStatus;
  freshness: ProviderMaintenanceFreshness;
  checkedAt: string | null;
  installMethod: ProviderMaintenanceInstallMethod;
  updateAvailability: ProviderMaintenanceUpdateAvailability;
  updateLabel: string | null;
  instructionsUrl: string;
  message: string | null;
}

export type ProviderMaintenanceOperationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "unchanged"
  | "failed"
  | "cancelled";

/**
 * Bounded, sanitized progress state for one explicit user-triggered update.
 */
export interface ProviderMaintenanceOperation {
  id: string;
  providerId: ProviderMaintenanceProviderId;
  status: ProviderMaintenanceOperationStatus;
  startedAt: string | null;
  finishedAt: string | null;
  beforeVersion: string | null;
  afterVersion: string | null;
  targetVersion: string | null;
  message: string;
  output: string | null;
  outputTruncated: boolean;
}

export const providerMaintenanceOperationIdSchema = z.string().uuid();
