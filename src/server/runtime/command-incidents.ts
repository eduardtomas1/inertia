import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ClientCommand, ServerEvent } from "../../shared/contracts";
import { diagnosticContextSchema, type DiagnosticContext } from "../../shared/application-diagnostics";
import type { IncidentObservation } from "../../node/application-incidents";
import { createIncidentReporter, type IncidentSink } from "../../node/application-incidents";
import { sendRuntimeEvent } from "../runtime-protocol";
import { SerializedRuntimeEvent } from "../serialized-runtime-event";
import type { StreamingTrace } from "./test-streaming-trace";

interface Operation {
  requestId: string;
  context: DiagnosticContext;
  code: "command.failed" | "git.command-failed" | "terminal.command-failed";
  incidentId: string;
  reported: boolean;
}

/**
 * One identity per (runtime generation, incident code, command type, project,
 * conversation, provider). Repeated identical failures then aggregate into one
 * record with an occurrence count instead of one indistinguishable row each,
 * and the request.error a user sees still names the record by that id.
 */
export function stableCommandIncidentId(
  generation: string | null,
  code: Operation["code"],
  commandType: string,
  context: DiagnosticContext,
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    generation, code, commandType,
    context.projectId ?? null, context.conversationId ?? null, context.providerId ?? null,
  ])).digest("hex");
  // RFC 4122 layout so the diagnostics schema's uuid check accepts it.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}`
    + `-${(0x8 | (Number.parseInt(digest[16]!, 16) & 0x3)).toString(16)}${digest.slice(17, 20)}`
    + `-${digest.slice(20, 32)}`;
}

/** Scoped to the original validated request; no mutable UI selection or payload is retained. */
export class CommandIncidents {
  private readonly operations = new AsyncLocalStorage<Operation>();
  constructor(
    private readonly sink: (observation: IncidentObservation) => unknown,
    private readonly generation: string | null = null,
  ) {}

  readonly report = (observation: IncidentObservation): unknown => {
    const operation = this.operations.getStore();
    // A terminal failure can also propagate as request.error. Preserve one
    // incident, with the turn's authoritative context and its original request.
    if (operation && observation.context?.turnId && observation.outcome === "failed") {
      if (operation.reported) return operation.incidentId;
      operation.reported = true;
      operation.incidentId = observation.id ?? operation.incidentId;
      return this.sink({ ...observation, id: operation.incidentId,
        correlationId: operation.requestId,
        context: { ...observation.context, requestId: operation.requestId } });
    }
    // A failure the command itself reports (a Git subsystem observation) is
    // the same user-visible operation as the request.error that follows it.
    if (operation && !observation.id && observation.code === operation.code) {
      if (operation.reported) return operation.incidentId;
      operation.reported = true;
      return this.sink({ ...observation, id: operation.incidentId,
        correlationId: operation.requestId,
        context: { ...operation.context, ...observation.context } });
    }
    return this.sink(observation);
  };

  static fromSink(sink: IncidentSink | undefined, generation: string | null): CommandIncidents {
    return new CommandIncidents(createIncidentReporter(sink, generation), generation);
  }

  sender(trace: StreamingTrace): typeof sendRuntimeEvent {
    return (socket, event, onSent) => {
      const value = event instanceof SerializedRuntimeEvent ? event.event : event;
      const streaming = value.type === "runtime.event" && value.event.type === "agent.text";
      if (streaming) trace.mark("runtime-event-serialized");
      if (streaming) trace.mark("runtime-websocket-send-started");
      const observed = this.observe(value);
      sendRuntimeEvent(socket, observed === value ? event : observed, onSent);
      if (streaming) trace.mark("runtime-websocket-send-accepted");
    };
  }

  run<T>(command: ClientCommand, execute: () => T): T {
    // A command dispatched while another is being observed belongs to that
    // outer operation: one user-visible failure, one incident.
    if (this.operations.getStore()) return execute();
    // The request id is kept for correlation but excluded from the incident
    // identity, so repeats of one failing operation aggregate.
    const context: DiagnosticContext = { requestId: command.requestId };
    const payload = "payload" in command && command.payload && typeof command.payload === "object"
      ? command.payload : {};
    for (const key of ["projectId", "conversationId", "turnId", "providerId"] as const) {
      if (key in payload) {
        const field = diagnosticContextSchema.shape[key].safeParse((payload as Record<string, unknown>)[key]);
        if (field.success && field.data) Object.assign(context, { [key]: field.data });
      }
    }
    const code = command.type.startsWith("git.") ? "git.command-failed"
      : command.type.startsWith("terminal.") ? "terminal.command-failed" : "command.failed";
    return this.operations.run({ requestId: command.requestId, context, code,
      incidentId: stableCommandIncidentId(this.generation, code, command.type, context),
      reported: false,
    }, execute);
  }

  observe(event: ServerEvent): ServerEvent {
    if (event.type !== "request.error") return event;
    const operation = this.operations.getStore();
    if (!operation || operation.requestId !== event.requestId) return event;
    if (!operation.reported) {
      operation.reported = true;
      this.report({ id: operation.incidentId, correlationId: operation.requestId,
        code: operation.code, outcome: "unknown", context: operation.context });
    }
    return { ...event, diagnosticId: operation.incidentId };
  }
}
