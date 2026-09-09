import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ClientCommand, ServerEvent } from "../../shared/contracts";
import { diagnosticContextSchema, type DiagnosticContext } from "../../shared/application-diagnostics";
import type { IncidentObservation } from "../../node/application-incidents";
import { createIncidentReporter, type IncidentSink } from "../../node/application-incidents";
import { sendRuntimeEvent } from "../runtime-protocol";
import type { StreamingTrace } from "./test-streaming-trace";

interface Operation {
  requestId: string;
  context: DiagnosticContext;
  code: "command.failed" | "git.command-failed" | "terminal.command-failed";
  incidentId: string;
  reported: boolean;
}

/** Scoped to the original validated request; no mutable UI selection or payload is retained. */
export class CommandIncidents {
  private readonly operations = new AsyncLocalStorage<Operation>();
  constructor(private readonly sink: (observation: IncidentObservation) => unknown) {}

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
    return this.sink(observation);
  };

  static fromSink(sink: IncidentSink | undefined, generation: string | null): CommandIncidents {
    return new CommandIncidents(createIncidentReporter(sink, generation));
  }

  sender(trace: StreamingTrace): typeof sendRuntimeEvent {
    return (socket, event, onSent) => {
      const streaming = event.type === "runtime.event" && event.event.type === "agent.text";
      if (streaming) trace.mark("runtime-event-serialized");
      if (streaming) trace.mark("runtime-websocket-send-started");
      sendRuntimeEvent(socket, this.observe(event), onSent);
      if (streaming) trace.mark("runtime-websocket-send-accepted");
    };
  }

  run<T>(command: ClientCommand, execute: () => T): T {
    const context: DiagnosticContext = { requestId: command.requestId };
    const payload = "payload" in command && command.payload && typeof command.payload === "object"
      ? command.payload : {};
    for (const key of ["projectId", "conversationId", "turnId", "providerId"] as const) {
      if (key in payload) {
        const field = diagnosticContextSchema.shape[key].safeParse((payload as Record<string, unknown>)[key]);
        if (field.success && field.data) Object.assign(context, { [key]: field.data });
      }
    }
    return this.operations.run({ requestId: command.requestId, context,
      code: command.type.startsWith("git.") ? "git.command-failed"
        : command.type.startsWith("terminal.") ? "terminal.command-failed" : "command.failed",
      incidentId: randomUUID(), reported: false,
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
