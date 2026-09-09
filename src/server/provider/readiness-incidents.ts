import { randomUUID } from "node:crypto";
import type { ProviderInfo } from "../../shared/contracts";
import type { DiagnosticCode } from "../../shared/application-diagnostics";
import type { IncidentObservation } from "../../node/application-incidents";

/** Observe authoritative readiness results; never parse arbitrary status prose. */
export class ProviderReadinessIncidents {
  private readonly episodes = new Map<ProviderInfo["id"], { id: string; code: DiagnosticCode }>();
  constructor(private readonly report: (observation: IncidentObservation) => unknown) {}

  observe(providers: readonly ProviderInfo[]): void {
    for (const provider of providers) {
      if (provider.installState === "checking" || provider.authState === "checking") continue;
      const previous = this.episodes.get(provider.id);
      const code: DiagnosticCode | null = provider.installState === "error" ? "provider.start-failed"
        : provider.installState !== "installed" || provider.canRun ? null
          : provider.authState === "unauthenticated" ? "provider.auth-failed"
            : "provider.connection-failed";
      if (previous && (provider.canRun || code !== previous.code)) {
        this.report({ id: previous.id, code: previous.code,
          outcome: provider.canRun ? "recovered" : "ended", context: { providerId: provider.id } });
        this.episodes.delete(provider.id);
      }
      if (!code || this.episodes.has(provider.id)) continue;
      const episode: { id: string; code: DiagnosticCode } = { id: randomUUID(), code };
      this.episodes.set(provider.id, episode);
      this.report({ ...episode, outcome: "failed", context: { providerId: provider.id } });
    }
  }
}
