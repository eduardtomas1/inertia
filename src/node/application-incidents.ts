import { randomUUID } from "node:crypto";
import {
  parseDiagnosticIncident,
  type DiagnosticCode,
  type DiagnosticContext,
  type DiagnosticIncident,
  type DiagnosticMetadata,
  type DiagnosticOutcome,
} from "../shared/application-diagnostics.js";

export type IncidentSink = (incident: DiagnosticIncident) => unknown;
export interface IncidentObservation {
  code: DiagnosticCode;
  outcome: DiagnosticOutcome;
  id?: string;
  correlationId?: string;
  context?: DiagnosticContext;
  metadata?: DiagnosticMetadata;
}

/** Explicit observations only; exceptions and user/provider content are not inputs. */
export function createIncidentReporter(
  sink: IncidentSink | undefined,
  runtimeGeneration: string | null = null,
  now: () => number = Date.now,
): (observation: IncidentObservation) => string | null {
  return (observation) => {
    if (!sink) return null;
    try {
      const id = observation.id ?? randomUUID();
      const incident = parseDiagnosticIncident({
        schemaVersion: 1, id, correlationId: observation.correlationId ?? id,
        code: observation.code, outcome: observation.outcome,
        at: new Date(now()).toISOString(), runtimeGeneration,
        context: observation.context ?? {}, metadata: observation.metadata ?? {},
      });
      if (!incident) return null;
      const result = sink(incident);
      // A custom sink may be asynchronous. Observability must never create an
      // unhandled rejection or delay the operation being observed.
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => undefined);
      }
      return id;
    } catch { return null; }
  };
}
