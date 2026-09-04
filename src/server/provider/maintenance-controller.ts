import { randomUUID } from "node:crypto";

import type {
  ProviderMaintenanceDiagnosticState,
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
  ProviderMaintenanceStatus,
} from "../../shared/provider-maintenance";
import {
  PROVIDER_MAINTENANCE_PROVIDER_IDS,
} from "../../shared/provider-maintenance";
import {
  providerChildEnvironment,
  providerEnvironment,
} from "../environment";
import {
  resolveProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceTarget,
  type ProviderMaintenanceUpdateAction,
} from "./maintenance-capabilities";
import {
  compareProviderVersions,
  ProviderLatestVersionCache,
} from "./maintenance-latest";
import {
  runProviderMaintenanceAction,
  type ProviderMaintenanceRunProgress,
  type ProviderMaintenanceRunResult,
} from "./maintenance-runner";
import {
  ProviderInstallationAdmissionError,
  ProviderInstallationLeaseCoordinator,
  providerInstallationIdentity,
  sameProviderInstallationBoundary,
  sameProviderInstallationIdentity,
  type ProviderInstallationBlocker,
  type ProviderInstallationIdentity,
  type ProviderInstallationMaintenanceLease,
  type ProviderInstallationVerificationAuthority,
} from "./installation-lease";
import type {
  ProviderMaintenanceJournalAuthority,
} from "./maintenance-journal";

const MAX_RETAINED_OPERATIONS = 64;

export class ProviderMaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderMaintenanceError";
  }
}

export interface ProviderMaintenanceControllerOptions {
  target(providerId: ProviderMaintenanceProviderId): ProviderMaintenanceTarget;
  refreshTarget(
    providerId: ProviderMaintenanceProviderId,
    verificationAuthority?: ProviderInstallationVerificationAuthority,
  ): Promise<ProviderMaintenanceTarget>;
  onStatus?(status: ProviderMaintenanceStatus): void;
  onOperation?(operation: ProviderMaintenanceOperation): void;
  latestVersions?: ProviderLatestVersionCache;
  resolveCapabilities?: (
    target: ProviderMaintenanceTarget,
  ) => Promise<ProviderMaintenanceCapabilities>;
  capabilityAvailable?: (
    target: ProviderMaintenanceTarget,
    capabilities: ProviderMaintenanceCapabilities,
  ) => boolean;
  runAction?: (
    action: ProviderMaintenanceUpdateAction,
    options: {
      signal: AbortSignal;
      onProgress(progress: ProviderMaintenanceRunProgress): void;
    },
  ) => Promise<ProviderMaintenanceRunResult>;
  now?: () => number;
  operationId?: () => string;
  installationLeases?: ProviderInstallationLeaseCoordinator;
  installationIdentity?: (
    target: ProviderMaintenanceTarget,
    capabilities: ProviderMaintenanceCapabilities,
  ) => ProviderInstallationIdentity;
  maintenanceAdmissionTimeoutMs?: number;
  onBlockers?(
    providerId: ProviderMaintenanceProviderId,
    blockers: readonly ProviderInstallationBlocker[],
  ): void;
  invalidateInstallationEvidence?(
    providerId: ProviderMaintenanceProviderId,
    verificationAuthority: ProviderInstallationVerificationAuthority | null,
    reason: "post-maintenance-verification" | "installation-uncertain",
  ): void | Promise<void>;
  /** Durable authority written before installation replacement is admitted. */
  maintenanceJournal: ProviderMaintenanceJournalAuthority;
}

interface ActiveProviderMaintenanceOperation {
  abort: AbortController;
  operation: ProviderMaintenanceOperation;
  completion: Promise<void> | null;
  installationIdentity: ProviderInstallationIdentity;
  installationLease: ProviderInstallationMaintenanceLease | null;
  verificationAuthority: ProviderInstallationVerificationAuthority | null;
  journalQuarantined: boolean;
  journalRetired: boolean;
}

type ProviderMaintenanceTerminalUpdate = Partial<ProviderMaintenanceOperation> & {
  status: "succeeded" | "unchanged" | "failed" | "cancelled";
  message: string;
};

class MaintenanceLockCancelled extends Error {}

class ProviderMaintenanceCommandCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(
    lockKey: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(lockKey, tail);

    let rejectAbort!: (error: MaintenanceLockCancelled) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = (): void => rejectAbort(new MaintenanceLockCancelled());
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (signal.aborted) throw new MaintenanceLockCancelled();
      await Promise.race([previous, aborted]);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) throw new MaintenanceLockCancelled();
      return await operation();
    } finally {
      signal.removeEventListener("abort", onAbort);
      release();
      if (this.tails.get(lockKey) === tail) {
        void tail.finally(() => {
          if (this.tails.get(lockKey) === tail) this.tails.delete(lockKey);
        });
      }
    }
  }
}

function versionStatus(
  installed: boolean,
  installedVersion: string | null,
  latestVersion: string | null,
): ProviderMaintenanceStatus["versionStatus"] {
  if (!installed) return "not-installed";
  const comparison = compareProviderVersions(
    installedVersion,
    latestVersion,
  );
  if (comparison === null) return "unknown";
  return comparison < 0 ? "update-available" : "current";
}

function statusMessage(
  status: ProviderMaintenanceStatus["versionStatus"],
  latestVersion: string | null,
  hasStaleData: boolean,
  error: string | null,
): string | null {
  if (status === "not-installed") return "Provider CLI is not installed.";
  if (status === "update-available") {
    return `${latestVersion ? `Version ${latestVersion}` : "An update"} is available${hasStaleData ? " (last known)" : ""}.`;
  }
  if (status === "current") {
    return hasStaleData
      ? "Installed version matches the last known release."
      : "Provider CLI is current.";
  }
  return error;
}

export class ProviderMaintenanceController {
  private readonly statuses = new Map<
    ProviderMaintenanceProviderId,
    ProviderMaintenanceStatus
  >();
  private readonly operations = new Map<string, ProviderMaintenanceOperation>();
  private readonly active = new Map<
    ProviderMaintenanceProviderId,
    ActiveProviderMaintenanceOperation
  >();
  private readonly reservations = new Set<ProviderMaintenanceProviderId>();
  private readonly coordinator = new ProviderMaintenanceCommandCoordinator();
  private readonly installationLeases: ProviderInstallationLeaseCoordinator;
  private readonly latestVersions: ProviderLatestVersionCache;
  private readonly now: () => number;
  private readonly operationId: () => string;
  private readonly maintenanceAdmissionTimeoutMs: number;
  private cleanupUnconfirmed = false;
  private readonly quarantinedProviders =
    new Set<ProviderMaintenanceProviderId>();

  constructor(private readonly options: ProviderMaintenanceControllerOptions) {
    this.latestVersions = options.latestVersions ?? new ProviderLatestVersionCache();
    this.installationLeases = options.installationLeases
      ?? new ProviderInstallationLeaseCoordinator();
    this.now = options.now ?? Date.now;
    this.operationId = options.operationId ?? randomUUID;
    this.maintenanceAdmissionTimeoutMs = Math.max(
      1,
      Math.min(options.maintenanceAdmissionTimeoutMs ?? 10_000, 60_000),
    );
  }

  current(
    providerId?: ProviderMaintenanceProviderId,
  ): ProviderMaintenanceStatus[] {
    if (providerId) {
      const current = this.statuses.get(providerId);
      return current ? [current] : [];
    }
    return PROVIDER_MAINTENANCE_PROVIDER_IDS.flatMap((id) => {
      const status = this.statuses.get(id);
      return status ? [status] : [];
    });
  }

  operation(operationId: string): ProviderMaintenanceOperation | null {
    return this.operations.get(operationId) ?? null;
  }

  /**
   * Renderer-safe, bounded projection of updates that still own runtime work.
   * Command output is intentionally omitted from full synchronization; live
   * operation events remain the only transport for sanitized output previews.
   */
  activeOperations(): ProviderMaintenanceOperation[] {
    return PROVIDER_MAINTENANCE_PROVIDER_IDS.flatMap((providerId) => {
      const operation = this.active.get(providerId)?.operation;
      if (
        !operation
        || (operation.status !== "queued" && operation.status !== "running")
      ) {
        return [];
      }
      return [{
        ...operation,
        output: null,
        outputTruncated: false,
      }];
    });
  }

  /** Bounded diagnostic state with no operation or installation identity. */
  diagnosticStates(): ProviderMaintenanceDiagnosticState[] {
    return PROVIDER_MAINTENANCE_PROVIDER_IDS.map((providerId) => {
      const operation = this.active.get(providerId)?.operation;
      const state: ProviderMaintenanceDiagnosticState["state"] =
        this.quarantinedProviders.has(providerId)
          ? "quarantined"
          : this.active.get(providerId)?.verificationAuthority
            ? "verifying"
            : operation?.status === "running"
              ? "running"
              : operation?.status === "queued"
                || this.reservations.has(providerId)
                ? "queued"
                : "idle";
      return { providerId, state };
    });
  }

  hasBlockingAuthority(providerId?: ProviderMaintenanceProviderId): boolean {
    let journalPending = true;
    try {
      journalPending = this.options.maintenanceJournal.pending().some(
        (record) => !providerId
          || record.installationIdentity.providerId === providerId,
      );
    } catch {
      // An unreadable or integrity-invalid journal is itself a blocker.
    }
    return (providerId ? this.active.has(providerId) : this.active.size > 0)
      || (providerId
        ? this.reservations.has(providerId)
        : this.reservations.size > 0)
      || (providerId
        ? this.quarantinedProviders.has(providerId)
        : this.quarantinedProviders.size > 0)
      || journalPending;
  }

  async refresh(
    providerIds: readonly ProviderMaintenanceProviderId[],
    force = false,
  ): Promise<ProviderMaintenanceStatus[]> {
    return await Promise.all(providerIds.map(
      async (providerId) => await this.refreshOne(providerId, force),
    ));
  }

  async startUpdate(
    providerId: ProviderMaintenanceProviderId,
  ): Promise<ProviderMaintenanceOperation> {
    if (this.active.has(providerId) || this.reservations.has(providerId)) {
      throw new ProviderMaintenanceError(
        "An update is already running for this provider.",
      );
    }
    this.reservations.add(providerId);
    try {
      const target = this.options.target(providerId);
      const capabilities = await this.capabilities(target);
      if (!capabilities.update) {
        throw new ProviderMaintenanceError(
          "This installation cannot be updated safely from Inertia. Review the official update instructions.",
        );
      }
      if (
        this.options.capabilityAvailable
        && !this.options.capabilityAvailable(target, capabilities)
      ) {
        throw new ProviderMaintenanceError(
          "The verified provider capability contract does not authorize an in-app update.",
        );
      }
      const installationIdentity = this.identity(target, capabilities);
      const operation: ProviderMaintenanceOperation = {
        id: this.operationId(),
        providerId,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        beforeVersion: target.installedVersion,
        afterVersion: null,
        targetVersion: this.statuses.get(providerId)?.latestVersion ?? null,
        message: "Waiting to start the provider update.",
        output: null,
        outputTruncated: false,
      };
      const active: ActiveProviderMaintenanceOperation = {
        abort: new AbortController(),
        operation,
        completion: null,
        installationIdentity,
        installationLease: null,
        verificationAuthority: null,
        journalQuarantined: false,
        journalRetired: false,
      };
      if (!this.options.maintenanceJournal.begin(
        operation.id,
        installationIdentity,
      )) {
        throw new ProviderMaintenanceError(
          "Provider maintenance ownership could not be recorded durably.",
        );
      }
      this.active.set(providerId, active);
      this.rememberOperation(operation);
      this.emitOperation(operation);
      const lease = this.installationLeases.acquireMaintenance(
        installationIdentity,
        {
          operationId: operation.id,
          signal: active.abort.signal,
          waitTimeoutMs: this.maintenanceAdmissionTimeoutMs,
          onBlockers: (blockers) => {
            this.options.onBlockers?.(providerId, blockers);
            this.updateOperation(active, {
              message: this.blockedMessage(blockers),
            });
          },
        },
      );
      active.completion = this.executeUpdate(
        active,
        capabilities,
        lease,
      );
      return operation;
    } finally {
      this.reservations.delete(providerId);
    }
  }

  cancel(operationId: string): ProviderMaintenanceOperation | null {
    const operation = this.operations.get(operationId);
    if (!operation) return null;
    const active = this.active.get(operation.providerId);
    if (active?.operation.id === operationId) active.abort.abort();
    return this.operations.get(operationId) ?? operation;
  }

  async dispose(): Promise<void> {
    const active = [...this.active.values()];
    for (const operation of active) operation.abort.abort();
    await Promise.allSettled(
      active
        .map((operation) => operation.completion)
        .filter((completion): completion is Promise<void> => completion !== null),
    );
    if (this.cleanupUnconfirmed) {
      throw new Error("Provider maintenance process cleanup could not be confirmed.");
    }
    if (this.quarantinedProviders.size > 0) {
      throw new Error("Provider maintenance installation quarantine remains unresolved.");
    }
    if (this.options.maintenanceJournal.pending().length > 0) {
      throw new Error("Provider maintenance journal ownership remains unresolved.");
    }
  }

  private async refreshOne(
    providerId: ProviderMaintenanceProviderId,
    force: boolean,
  ): Promise<ProviderMaintenanceStatus> {
    const target = this.options.target(providerId);
    const capabilities = await this.capabilities(target);
    const latest = capabilities.packageName && target.installed
      ? await this.latestVersions.latest(capabilities.packageName, force)
      : {
          version: null,
          freshness: "unavailable" as const,
          checkedAt: null,
          error: target.installed && providerId === "cursor"
            ? "Cursor does not publish a machine-readable latest-version source."
            : null,
        };
    const resolvedVersionStatus = versionStatus(
      target.installed,
      target.installedVersion,
      latest.version,
    );
    const status: ProviderMaintenanceStatus = {
      providerId,
      installedVersion: target.installedVersion,
      latestVersion: latest.version,
      versionStatus: resolvedVersionStatus,
      freshness: latest.freshness,
      checkedAt: latest.checkedAt,
      installMethod: capabilities.installMethod,
      updateAvailability: capabilities.updateAvailability,
      updateLabel: capabilities.update?.label ?? null,
      instructionsUrl: capabilities.instructionsUrl,
      message: statusMessage(
        resolvedVersionStatus,
        latest.version,
        latest.freshness === "stale",
        latest.error,
      ),
    };
    this.statuses.set(providerId, status);
    this.options.onStatus?.(status);
    return status;
  }

  private async executeUpdate(
    active: ActiveProviderMaintenanceOperation,
    capabilities: ProviderMaintenanceCapabilities,
    leaseAcquisition: Promise<ProviderInstallationMaintenanceLease>,
  ): Promise<void> {
    const { providerId } = active.operation;
    const action = capabilities.update!;
    let commandStarted = false;
    let result: ProviderMaintenanceRunResult | null = null;
    let installationAuthoritySettled = false;
    try {
      const lease = await leaseAcquisition;
      active.installationLease = lease;
      const beforeAction = this.identity(
        this.options.target(providerId),
        capabilities,
      );
      if (!sameProviderInstallationIdentity(
        active.installationIdentity,
        beforeAction,
      )) {
        this.quarantineInstallation(
          active,
          "installation-changed-before-maintenance",
          beforeAction,
        );
        await this.invalidateUncertainInstallationEvidence(active);
        installationAuthoritySettled = true;
        this.finishOperation(active, {
          status: "failed",
          message: "The provider installation changed before the update could start. It remains quarantined for verification.",
        });
        return;
      }

      const advisory = await this.refreshOne(providerId, false);
      result = await this.coordinator.run(
        action.lockKey,
        active.abort.signal,
        async () => {
          commandStarted = true;
          this.updateOperation(active, {
            status: "running",
            startedAt: this.isoNow(),
            targetVersion: advisory.latestVersion,
            message: "Updating provider.",
          });
          return await this.runAction(action, active);
        },
      );
      this.cleanupUnconfirmed ||= !result.cleanupConfirmed;
      if (!result.cleanupConfirmed) {
        this.quarantineInstallation(
          active,
          "maintenance-process-cleanup-unconfirmed",
        );
        await this.invalidateUncertainInstallationEvidence(active);
        installationAuthoritySettled = true;
        this.finishOperation(active, {
          status: "failed",
          message: "Provider update cleanup could not be confirmed. The installation remains quarantined.",
          output: result.output,
          outputTruncated: result.outputTruncated,
        });
        return;
      }
      if (!await this.beginPostMaintenanceVerification(active)) {
        installationAuthoritySettled = true;
        this.finishOperation(active, {
          status: "failed",
          message: "The provider update ended without exact verification authority. The installation remains quarantined.",
        });
        return;
      }
      if (result.status === "cancelled") {
        const observed = await this.revalidateUnchangedInstallation(
          active,
          capabilities,
        );
        if (!observed) {
          installationAuthoritySettled = true;
          return;
        }
        const completed = await this.completeInstallationAuthority(
          active,
          observed,
        );
        installationAuthoritySettled = true;
        this.finishOperation(active, completed
          ? {
              status: "cancelled",
              message: result.message,
              output: result.output,
              outputTruncated: result.outputTruncated,
            }
          : {
              status: "failed",
              message: "The cancelled update could not release exact installation authority. The installation remains quarantined.",
            });
        return;
      }
      if (result.status !== "succeeded") {
        const observed = await this.revalidateUnchangedInstallation(
          active,
          capabilities,
        );
        if (!observed) {
          installationAuthoritySettled = true;
          return;
        }
        const completed = await this.completeInstallationAuthority(
          active,
          observed,
        );
        installationAuthoritySettled = true;
        this.finishOperation(active, completed
          ? {
              status: "failed",
              message: result.message,
              output: result.output,
              outputTruncated: result.outputTruncated,
            }
          : {
              status: "failed",
              message: "The failed update could not release exact installation authority. The installation remains quarantined.",
              output: result.output,
              outputTruncated: result.outputTruncated,
            });
        return;
      }
      const verified = await this.verifyUpdate(active, result, capabilities);
      if (!verified) {
        installationAuthoritySettled = true;
        return;
      }
      const completed = await this.completeInstallationAuthority(
        active,
        verified.observedIdentity,
      );
      installationAuthoritySettled = true;
      this.finishOperation(active, completed
        ? verified.terminal
        : {
            status: "failed",
            message: "The provider update was verified, but exact installation authority could not be released. The installation remains quarantined.",
            output: result.output,
            outputTruncated: result.outputTruncated,
          });
    } catch (error) {
      if (error instanceof MaintenanceLockCancelled || active.abort.signal.aborted) {
        this.finishOperation(active, {
          status: "cancelled",
          message: "Provider update cancelled.",
        });
      } else {
        this.finishOperation(active, {
          status: "failed",
          message: this.maintenanceErrorMessage(error),
        });
      }
    } finally {
      if (active.installationLease && !installationAuthoritySettled) {
        if (!commandStarted) {
          installationAuthoritySettled = await this.completeInstallationAuthority(
            active,
            active.installationIdentity,
          );
        } else {
          this.quarantineInstallation(
            active,
            result?.cleanupConfirmed === true
              ? "maintenance-terminal-state-unverified"
              : "maintenance-process-cleanup-unconfirmed",
          );
          this.cleanupUnconfirmed ||= result?.cleanupConfirmed !== true;
          await this.invalidateUncertainInstallationEvidence(active);
          installationAuthoritySettled = true;
        }
      }
      if (
        !active.installationLease
        && !commandStarted
        && !active.journalQuarantined
        && !active.journalRetired
      ) {
        active.journalRetired = this.options.maintenanceJournal.abandonUnadmitted(
          active.operation.id,
          active.installationIdentity,
        );
        if (!active.journalRetired) {
          this.quarantinedProviders.add(active.operation.providerId);
          active.journalQuarantined = true;
        }
      }
      if (this.active.get(providerId)?.operation.id === active.operation.id) {
        this.active.delete(providerId);
      }
    }
  }

  private async verifyUpdate(
    active: ActiveProviderMaintenanceOperation,
    result: ProviderMaintenanceRunResult,
    capabilities: ProviderMaintenanceCapabilities,
  ): Promise<{
    observedIdentity: ProviderInstallationIdentity;
    terminal: ProviderMaintenanceTerminalUpdate;
  } | null> {
    let refreshed: ProviderMaintenanceTarget;
    try {
      refreshed = await this.options.refreshTarget(
        active.operation.providerId,
        active.verificationAuthority ?? undefined,
      );
    } catch {
      this.quarantineInstallation(
        active,
        "maintenance-post-update-verification-unavailable",
      );
      await this.invalidateUncertainInstallationEvidence(active);
      this.finishOperation(active, {
        status: "unchanged",
        message: "Update completed, but Inertia could not verify the installed version. The installation remains quarantined.",
        output: result.output,
        outputTruncated: result.outputTruncated,
      });
      return null;
    }
    const observedIdentity = this.identity(refreshed, capabilities);
    if (!sameProviderInstallationBoundary(
      active.installationIdentity,
      observedIdentity,
    )) {
      this.quarantineInstallation(
        active,
        "maintenance-changed-installation-scope",
        observedIdentity,
      );
      await this.invalidateUncertainInstallationEvidence(active);
      this.finishOperation(active, {
        status: "failed",
        afterVersion: refreshed.installedVersion,
        message: "The update resolved to a different provider installation. Both installations remain quarantined for verification.",
        output: result.output,
        outputTruncated: result.outputTruncated,
      });
      return null;
    }
    const advisory = await this.refreshOne(active.operation.providerId, true);
    const targetReached = advisory.versionStatus === "current";
    const versionChanged = compareProviderVersions(
      refreshed.installedVersion,
      active.operation.beforeVersion,
    );
    return {
      observedIdentity,
      terminal: {
        status: targetReached || (versionChanged !== null && versionChanged > 0)
          ? "succeeded"
          : "unchanged",
        afterVersion: refreshed.installedVersion,
        message: targetReached || (versionChanged !== null && versionChanged > 0)
          ? "Provider updated."
          : "Update completed, but the installed version still appears unchanged.",
        output: result.output,
        outputTruncated: result.outputTruncated,
      },
    };
  }

  private async revalidateUnchangedInstallation(
    active: ActiveProviderMaintenanceOperation,
    capabilities: ProviderMaintenanceCapabilities,
  ): Promise<ProviderInstallationIdentity | null> {
    let refreshed: ProviderMaintenanceTarget;
    try {
      refreshed = await this.options.refreshTarget(
        active.operation.providerId,
        active.verificationAuthority ?? undefined,
      );
    } catch {
      this.quarantineInstallation(
        active,
        "maintenance-post-action-verification-unavailable",
      );
      await this.invalidateUncertainInstallationEvidence(active);
      this.finishOperation(active, {
        status: "failed",
        message: "The provider update ended, but the installation could not be reverified. It remains quarantined.",
      });
      return null;
    }
    const observed = this.identity(refreshed, capabilities);
    if (!sameProviderInstallationIdentity(
      active.installationIdentity,
      observed,
    )) {
      this.quarantineInstallation(
        active,
        "installation-changed-after-unsuccessful-maintenance",
        observed,
      );
      await this.invalidateUncertainInstallationEvidence(active);
      this.finishOperation(active, {
        status: "failed",
        afterVersion: refreshed.installedVersion,
        message: "The provider installation changed without a verified successful update. It remains quarantined.",
      });
      return null;
    }
    return observed;
  }

  private async beginPostMaintenanceVerification(
    active: ActiveProviderMaintenanceOperation,
  ): Promise<boolean> {
    const lease = active.installationLease;
    if (!lease) return false;
    const authority = lease.authorizePostMaintenanceVerification({
      cleanupConfirmed: true,
    });
    if (!authority) {
      this.quarantineInstallation(
        active,
        "post-maintenance-verification-authority-unavailable",
      );
      await this.invalidateUncertainInstallationEvidence(active);
      return false;
    }
    active.verificationAuthority = authority;
    try {
      await this.options.invalidateInstallationEvidence?.(
        active.operation.providerId,
        authority,
        "post-maintenance-verification",
      );
      return true;
    } catch {
      this.quarantineInstallation(
        active,
        "maintenance-evidence-invalidation-failed",
      );
      await this.invalidateUncertainInstallationEvidence(active);
      return false;
    }
  }

  private async completeInstallationAuthority(
    active: ActiveProviderMaintenanceOperation,
    observedIdentity: ProviderInstallationIdentity,
  ): Promise<boolean> {
    const lease = active.installationLease;
    if (!lease) return false;
    active.verificationAuthority ??=
      lease.authorizePostMaintenanceVerification({ cleanupConfirmed: true });
    if (!active.verificationAuthority) {
      this.quarantineInstallation(
        active,
        "post-maintenance-verification-authority-unavailable",
        observedIdentity,
      );
      await this.invalidateUncertainInstallationEvidence(active);
      return false;
    }
    if (!this.options.maintenanceJournal.markVerified(
      active.operation.id,
      observedIdentity,
    )) {
      this.quarantineInstallation(
        active,
        "maintenance-terminal-state-not-durable",
        observedIdentity,
      );
      await this.invalidateUncertainInstallationEvidence(active);
      return false;
    }
    const completed = lease.complete({
      cleanupConfirmed: true,
      stateDurable: true,
      observedIdentity,
    });
    active.installationLease = null;
    if (!completed) {
      this.quarantinedProviders.add(active.operation.providerId);
      await this.invalidateUncertainInstallationEvidence(active);
      return false;
    }
    active.journalRetired = this.options.maintenanceJournal.retireVerified(
      active.operation.id,
      observedIdentity,
    );
    if (!active.journalRetired) {
      this.quarantinedProviders.add(active.operation.providerId);
      active.journalQuarantined = true;
      this.installationLeases.quarantineObservation(
        observedIdentity,
        { kind: "startup-recovery", operationId: active.operation.id },
        "maintenance-journal-retirement-unconfirmed",
      );
      await this.invalidateUncertainInstallationEvidence(active);
      return false;
    }
    return true;
  }

  private quarantineInstallation(
    active: ActiveProviderMaintenanceOperation,
    reason: string,
    observedIdentity?: ProviderInstallationIdentity,
  ): void {
    this.quarantinedProviders.add(active.operation.providerId);
    active.journalQuarantined = true;
    active.installationLease?.quarantine(reason, observedIdentity);
    active.installationLease = null;
  }

  private async invalidateUncertainInstallationEvidence(
    active: ActiveProviderMaintenanceOperation,
  ): Promise<void> {
    try {
      await this.options.invalidateInstallationEvidence?.(
        active.operation.providerId,
        null,
        "installation-uncertain",
      );
    } catch {
      // Quarantine is already latched. Cache invalidation failure cannot make
      // the installation eligible for new work or continuation.
    }
  }

  private identity(
    target: ProviderMaintenanceTarget,
    capabilities: ProviderMaintenanceCapabilities,
  ): ProviderInstallationIdentity {
    if (this.options.installationIdentity) {
      return this.options.installationIdentity(target, capabilities);
    }
    return providerInstallationIdentity({
      providerId: target.providerId,
      executable: target.executable,
      installationRootIdentity: null,
      packageIdentity: capabilities.packageName,
      version: target.installedVersion,
      environmentIdentity: "runtime-provider-environment",
    });
  }

  private blockedMessage(
    blockers: readonly ProviderInstallationBlocker[],
  ): string {
    const counts = new Map<string, number>();
    for (const blocker of blockers) {
      counts.set(blocker.kind, (counts.get(blocker.kind) ?? 0) + 1);
    }
    const summary = [...counts]
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");
    return summary
      ? `Waiting for provider installation owners to finish (${summary}).`
      : "Waiting for provider installation owners to finish.";
  }

  private maintenanceErrorMessage(error: unknown): string {
    if (error instanceof ProviderMaintenanceError) return error.message;
    if (error instanceof ProviderInstallationAdmissionError) {
      const blocked = this.blockedMessage(error.blockers);
      return error.blockers.length > 0 ? blocked : error.message;
    }
    return "Provider update failed.";
  }

  private async capabilities(
    target: ProviderMaintenanceTarget,
  ): Promise<ProviderMaintenanceCapabilities> {
    return await (
      this.options.resolveCapabilities
      ?? resolveProviderMaintenanceCapabilities
    )(target);
  }

  private async runAction(
    action: ProviderMaintenanceUpdateAction,
    active: ActiveProviderMaintenanceOperation,
  ): Promise<ProviderMaintenanceRunResult> {
    const onProgress = (progress: ProviderMaintenanceRunProgress): void => {
      this.updateOperation(active, progress);
    };
    if (this.options.runAction) {
      return await this.options.runAction(action, {
        signal: active.abort.signal,
        onProgress,
      });
    }
    const environment = await providerEnvironment();
    return await runProviderMaintenanceAction(action, {
      environment: providerChildEnvironment(
        active.operation.providerId,
        environment.env,
      ),
      signal: active.abort.signal,
      onProgress,
    });
  }

  private updateOperation(
    active: ActiveProviderMaintenanceOperation,
    update: Partial<ProviderMaintenanceOperation>,
  ): void {
    active.operation = { ...active.operation, ...update };
    this.rememberOperation(active.operation);
    this.emitOperation(active.operation);
  }

  private finishOperation(
    active: ActiveProviderMaintenanceOperation,
    update: ProviderMaintenanceTerminalUpdate,
  ): void {
    this.updateOperation(active, {
      ...update,
      finishedAt: this.isoNow(),
    });
  }

  private rememberOperation(operation: ProviderMaintenanceOperation): void {
    this.operations.delete(operation.id);
    this.operations.set(operation.id, operation);
    while (this.operations.size > MAX_RETAINED_OPERATIONS) {
      const oldest = this.operations.keys().next().value;
      if (typeof oldest !== "string") break;
      if ([...this.active.values()].some(
        (active) => active.operation.id === oldest,
      )) break;
      this.operations.delete(oldest);
    }
  }

  private emitOperation(operation: ProviderMaintenanceOperation): void {
    this.options.onOperation?.(operation);
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}
