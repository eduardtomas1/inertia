import { createIncidentReporter, type IncidentSink } from "../node/application-incidents.js";
import type { DiagnosticIncident } from "../shared/application-diagnostics.js";
import type { RuntimeSupervisorPhase } from "./runtime-supervisor-types.js";

export function isRuntimeIncidentMessage(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "runtime.incident");
}

/** Observes the existing supervisor; does not schedule, terminate or restart anything. */
export class RuntimeIncidentObserver {
  private phase: RuntimeSupervisorPhase = "idle";
  private recovery: { id: string; generation: string | null } | null = null;
  constructor(private readonly sink: IncidentSink | undefined) {}

  accept(incident: DiagnosticIncident, generation: string): void {
    if (incident.runtimeGeneration !== generation) return;
    try { this.sink?.(incident); } catch { /* Observational only. */ }
  }

  exited(generation: string, wasReady: boolean, unexpected: boolean, exitCode: number): void {
    if (!unexpected) return;
    createIncidentReporter(this.sink, generation)({
      code: wasReady ? "runtime.exited" : "runtime.start-failed", outcome: "unknown",
      metadata: Number.isInteger(exitCode) && exitCode >= -255 && exitCode <= 255 ? { exitCode } : {},
    });
  }

  state(phase: RuntimeSupervisorPhase, generation: string | null): void {
    if (this.phase === phase) return;
    this.phase = phase;
    const report = createIncidentReporter(this.sink, generation);
    if (phase === "restarting" && !this.recovery) {
      const id = report({ code: "runtime.restarting", outcome: "observing" });
      if (id) this.recovery = { id, generation };
    }
    if (phase === "ready" && this.recovery) {
      const episode = this.recovery; this.recovery = null;
      createIncidentReporter(this.sink, episode.generation)({
        id: episode.id, code: "runtime.restarting", outcome: "recovered",
      });
      report({ code: "runtime.reconnected", outcome: "recovered", correlationId: episode.id });
    }
  }
}
