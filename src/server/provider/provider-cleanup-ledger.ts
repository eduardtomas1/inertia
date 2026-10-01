import {
  isProcessTreeTerminationUnconfirmed,
  posixCleanupDiagnosticOf,
} from "../process-lifecycle";
import {
  describePosixCleanupDiagnostic,
  type PosixCleanupDiagnostic,
} from "../posix-cleanup-diagnostics";
import type { ProviderId } from "./contracts";

type ProviderCleanupDiagnostics = ReadonlyMap<ProviderId, PosixCleanupDiagnostic | null>;

export class ProviderCleanupLedger {
  private readonly unconfirmed = new Map<ProviderId, PosixCleanupDiagnostic | null>();

  has(providerId: ProviderId): boolean {
    return this.unconfirmed.has(providerId);
  }

  recordFailure(providerId: ProviderId, error: unknown): boolean {
    const cleanupUnconfirmed = isProcessTreeTerminationUnconfirmed(error);
    if (cleanupUnconfirmed) this.unconfirmed.set(providerId, posixCleanupDiagnosticOf(error));
    return cleanupUnconfirmed;
  }

  observe(
    providerId: ProviderId,
    cleanupConfirmed: boolean,
    diagnostic: PosixCleanupDiagnostic | null,
  ): void {
    if (cleanupConfirmed) this.unconfirmed.delete(providerId);
    else this.unconfirmed.set(providerId, diagnostic);
  }

  diagnostics(): ProviderCleanupDiagnostics {
    return new Map(this.unconfirmed);
  }
}

function describeProviderCleanup(
  source: string,
  diagnostics: ProviderCleanupDiagnostics,
): string[] {
  return [...diagnostics].map(([providerId, diagnostic]) =>
    `${providerId} ${source} ${diagnostic
      ? describePosixCleanupDiagnostic(diagnostic)
      : "[no POSIX classification]"}`);
}

export function providerCleanupUnconfirmedError(sources: {
  runCleanupConfirmed: boolean;
  installationUncertain: boolean;
  discovery: ProviderCleanupDiagnostics;
  metadata: ProviderCleanupDiagnostics;
}): Error | null {
  const unconfirmed = [
    ...(sources.runCleanupConfirmed ? [] : ["provider runs"]),
    ...(sources.installationUncertain ? ["installation authority"] : []),
    ...describeProviderCleanup("discovery", sources.discovery),
    ...describeProviderCleanup("metadata", sources.metadata),
  ];
  return unconfirmed.length === 0
    ? null
    : new Error(
        `Provider process cleanup could not be confirmed. Unconfirmed: ${unconfirmed.join("; ")}.`,
      );
}
