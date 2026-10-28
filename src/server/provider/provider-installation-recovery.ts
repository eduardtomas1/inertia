import type {
  ProviderId,
  ProviderRunCallbacks,
  ProviderRunResult,
} from "./contracts";
import {
  USER_RECOVERABLE_QUARANTINE_KINDS,
  type ProviderInstallationLeaseCoordinator,
  type ProviderInstallationUseKind,
} from "./installation-lease";
import { clearOpenCodePureIsolationCleanupFailures } from "./opencode-pure-isolation";

export type ProviderInstallationEventKind =
  | "run-start-failed"
  | "run-cleanup-unconfirmed"
  | "probe-cleanup-unconfirmed";

export interface ProviderInstallationEvent {
  providerId: ProviderId;
  kind: ProviderInstallationEventKind;
}

const DETECTION_LIFT_KINDS: ReadonlySet<ProviderInstallationUseKind> = new Set([
  "compatibility-probe",
  "metadata-discovery",
]);

export class ProviderInstallationRecovery {
  private readonly runs = new Map<symbol, ProviderId>();
  private readonly listeners = new Set<(event: ProviderInstallationEvent) => void>();

  constructor(private readonly leases: ProviderInstallationLeaseCoordinator | undefined) {}

  trackRun(providerId: ProviderId): () => void {
    const token = Symbol(providerId);
    this.runs.set(token, providerId);
    return () => {
      this.runs.delete(token);
    };
  }

  hasActiveRun(providerId: ProviderId): boolean {
    return [...this.runs.values()].includes(providerId);
  }

  replacementAdmissible(providerId: ProviderId): boolean {
    return !this.hasActiveRun(providerId)
      && (this.leases?.activeUseCount(providerId) ?? 0) <= 1;
  }

  liftForDetection(providerId: ProviderId): void {
    this.leases?.liftProviderQuarantines(providerId, DETECTION_LIFT_KINDS);
  }

  liftForUser(providerId: ProviderId): boolean {
    if (providerId === "opencode") clearOpenCodePureIsolationCleanupFailures();
    if (this.hasActiveRun(providerId)) return false;
    this.leases?.liftProviderQuarantines(providerId, USER_RECOVERABLE_QUARANTINE_KINDS);
    return true;
  }

  observe(listener: (event: ProviderInstallationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  report(providerId: ProviderId, kind: ProviderInstallationEventKind): void {
    for (const listener of this.listeners) {
      try {
        listener({ providerId, kind });
      } catch {
        continue;
      }
    }
  }

  observeRun(
    providerId: ProviderId,
    callbacks: ProviderRunCallbacks,
    start: (callbacks: ProviderRunCallbacks) => Promise<ProviderRunResult>,
  ): Promise<ProviderRunResult> {
    let started = false;
    let handshake = false;
    const result = start({
      ...callbacks,
      onStarted: () => {
        started = true;
        callbacks.onStarted?.();
      },
      onSession: (event) => {
        handshake = true;
        callbacks.onSession?.(event);
      },
    });
    const settle = (failed: boolean): void => {
      if (failed && started && !handshake) this.report(providerId, "run-start-failed");
    };
    void result.then(({ status }) => settle(status === "failed"), () => settle(true));
    return result;
  }
}
