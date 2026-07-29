import { randomUUID } from "node:crypto";

import type {
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
  ): Promise<ProviderMaintenanceTarget>;
  onStatus?(status: ProviderMaintenanceStatus): void;
  onOperation?(operation: ProviderMaintenanceOperation): void;
  latestVersions?: ProviderLatestVersionCache;
  resolveCapabilities?: (
    target: ProviderMaintenanceTarget,
  ) => Promise<ProviderMaintenanceCapabilities>;
  runAction?: (
    action: ProviderMaintenanceUpdateAction,
    options: {
      signal: AbortSignal;
      onProgress(progress: ProviderMaintenanceRunProgress): void;
    },
  ) => Promise<ProviderMaintenanceRunResult>;
  now?: () => number;
  operationId?: () => string;
}

interface ActiveProviderMaintenanceOperation {
  abort: AbortController;
  operation: ProviderMaintenanceOperation;
  completion: Promise<void> | null;
}

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
  private readonly latestVersions: ProviderLatestVersionCache;
  private readonly now: () => number;
  private readonly operationId: () => string;

  constructor(private readonly options: ProviderMaintenanceControllerOptions) {
    this.latestVersions = options.latestVersions ?? new ProviderLatestVersionCache();
    this.now = options.now ?? Date.now;
    this.operationId = options.operationId ?? randomUUID;
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
      const advisory = await this.refreshOne(providerId, false);
      const operation: ProviderMaintenanceOperation = {
        id: this.operationId(),
        providerId,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        beforeVersion: target.installedVersion,
        afterVersion: null,
        targetVersion: advisory.latestVersion,
        message: "Waiting to start the provider update.",
        output: null,
        outputTruncated: false,
      };
      const active: ActiveProviderMaintenanceOperation = {
        abort: new AbortController(),
        operation,
        completion: null,
      };
      this.active.set(providerId, active);
      this.rememberOperation(operation);
      this.emitOperation(operation);
      active.completion = this.executeUpdate(active, capabilities.update);
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
    action: ProviderMaintenanceUpdateAction,
  ): Promise<void> {
    const { providerId } = active.operation;
    try {
      const result = await this.coordinator.run(
        action.lockKey,
        active.abort.signal,
        async () => {
          this.updateOperation(active, {
            status: "running",
            startedAt: this.isoNow(),
            message: "Updating provider.",
          });
          return await this.runAction(action, active);
        },
      );
      if (result.status === "cancelled") {
        this.finishOperation(active, {
          status: "cancelled",
          message: result.message,
          output: result.output,
          outputTruncated: result.outputTruncated,
        });
        return;
      }
      if (result.status !== "succeeded") {
        this.finishOperation(active, {
          status: "failed",
          message: result.message,
          output: result.output,
          outputTruncated: result.outputTruncated,
        });
        return;
      }
      await this.verifyUpdate(active, result);
    } catch (error) {
      if (error instanceof MaintenanceLockCancelled || active.abort.signal.aborted) {
        this.finishOperation(active, {
          status: "cancelled",
          message: "Provider update cancelled.",
        });
      } else {
        this.finishOperation(active, {
          status: "failed",
          message: error instanceof ProviderMaintenanceError
            ? error.message
            : "Provider update failed.",
        });
      }
    } finally {
      if (this.active.get(providerId)?.operation.id === active.operation.id) {
        this.active.delete(providerId);
      }
    }
  }

  private async verifyUpdate(
    active: ActiveProviderMaintenanceOperation,
    result: ProviderMaintenanceRunResult,
  ): Promise<void> {
    let refreshed: ProviderMaintenanceTarget;
    try {
      refreshed = await this.options.refreshTarget(active.operation.providerId);
    } catch {
      this.finishOperation(active, {
        status: "unchanged",
        message: "Update completed, but Inertia could not verify the installed version.",
        output: result.output,
        outputTruncated: result.outputTruncated,
      });
      return;
    }
    const advisory = await this.refreshOne(active.operation.providerId, true);
    const targetReached = advisory.versionStatus === "current";
    const versionChanged = compareProviderVersions(
      refreshed.installedVersion,
      active.operation.beforeVersion,
    );
    this.finishOperation(active, {
      status: targetReached || (versionChanged !== null && versionChanged > 0)
        ? "succeeded"
        : "unchanged",
      afterVersion: refreshed.installedVersion,
      message: targetReached || (versionChanged !== null && versionChanged > 0)
        ? "Provider updated."
        : "Update completed, but the installed version still appears unchanged.",
      output: result.output,
      outputTruncated: result.outputTruncated,
    });
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
    update: Partial<ProviderMaintenanceOperation> & {
      status: "succeeded" | "unchanged" | "failed" | "cancelled";
      message: string;
    },
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
