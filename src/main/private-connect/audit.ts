import { randomUUID } from "node:crypto";
import { PRIVATE_CONNECT_LIMITS } from "../../shared/private-connect/limits";
import type { PrivateConnectRequest, PrivateConnectResponse } from "../../shared/private-connect/protocol";
import type { PersistedPrivateConnect, PrivateConnectAuditEvent } from "./store";

const connectionEvent = (event: PrivateConnectAuditEvent): boolean =>
  event.type === "session.connected" || event.type === "session.disconnected";

export function appendPrivateConnectAudit(
  data: PersistedPrivateConnect,
  event: Omit<PrivateConnectAuditEvent, "id">,
): void {
  data.audit.push({ ...event, id: randomUUID() });
  let connections = data.audit.filter(connectionEvent).length;
  data.audit = data.audit.filter((entry) => {
    if (!connectionEvent(entry) || connections <= 100) return true;
    connections -= 1;
    return false;
  });
  while (data.audit.length > PRIVATE_CONNECT_LIMITS.auditEvents) {
    const connection = data.audit.findIndex(connectionEvent);
    data.audit.splice(connection < 0 ? 0 : connection, 1);
  }
}

export function recentPrivateConnectAudit(audit: readonly PrivateConnectAuditEvent[]): PrivateConnectAuditEvent[] {
  // Reserve visible history for meaningful actions as well as connection diagnostics.
  const recentConnections = new Set(audit.filter(connectionEvent).slice(-10));
  return audit.filter((entry) => !connectionEvent(entry) || recentConnections.has(entry)).slice(-50);
}

interface MutationAudit {
  record(type: PrivateConnectAuditEvent["type"], detail: string): void;
  persist(): Promise<void>;
  dispatch(): Promise<PrivateConnectResponse>;
}

export type PrivateConnectAuditedMutationRequest = Extract<
  PrivateConnectRequest,
  {
    type:
      | "input.respond"
      | "run.stop"
      | "queue.send"
      | "queue.edit"
      | "queue.remove"
      | "queue.resume"
      | "scheduled-task.toggle"
      | "scheduled-task.run-now"
      | "scheduled-task.delete";
  }
>;

const MUTATION_META: Readonly<Record<PrivateConnectAuditedMutationRequest["type"], {
  started: string;
  expectedKind:
    | "input.accepted"
    | "run.stopped"
    | "queue.updated"
    | "scheduled-task.updated"
    | "scheduled-task.ran"
    | "scheduled-task.deleted";
  acceptedType: PrivateConnectAuditEvent["type"];
  acceptedDetail: string;
}>> = {
  "input.respond": {
    started: "A remote answer was requested.",
    expectedKind: "input.accepted",
    acceptedType: "input.accepted",
    acceptedDetail: "A remote answer was accepted.",
  },
  "run.stop": {
    started: "A remote stop was requested.",
    expectedKind: "run.stopped",
    acceptedType: "run.stop-accepted",
    acceptedDetail: "A remote stop request was accepted.",
  },
  "queue.send": {
    started: "A remote queued-message send was requested.",
    expectedKind: "queue.updated",
    acceptedType: "prompt.accepted",
    acceptedDetail: "A remote queued-message send was accepted.",
  },
  "queue.edit": {
    started: "A remote queued-message edit was requested.",
    expectedKind: "queue.updated",
    acceptedType: "prompt.accepted",
    acceptedDetail: "A remote queued-message edit was accepted.",
  },
  "queue.remove": {
    started: "A remote queued-message removal was requested.",
    expectedKind: "queue.updated",
    acceptedType: "prompt.accepted",
    acceptedDetail: "A remote queued-message removal was accepted.",
  },
  "queue.resume": {
    started: "A remote queue resume was requested.",
    expectedKind: "queue.updated",
    acceptedType: "prompt.accepted",
    acceptedDetail: "A remote queue resume was accepted.",
  },
  "scheduled-task.toggle": {
    started: "A remote scheduled-task update was requested.",
    expectedKind: "scheduled-task.updated",
    acceptedType: "scheduled-task.accepted",
    acceptedDetail: "A remote scheduled-task update was accepted.",
  },
  "scheduled-task.run-now": {
    started: "A remote scheduled-task run was requested.",
    expectedKind: "scheduled-task.ran",
    acceptedType: "scheduled-task.accepted",
    acceptedDetail: "A remote scheduled-task run was accepted.",
  },
  "scheduled-task.delete": {
    started: "A remote scheduled-task deletion was requested.",
    expectedKind: "scheduled-task.deleted",
    acceptedType: "scheduled-task.deleted",
    acceptedDetail: "A remote scheduled-task deletion was accepted.",
  },
};

export async function runAuditedPrivateConnectMutation(
  request: PrivateConnectAuditedMutationRequest,
  audit: MutationAudit,
): Promise<PrivateConnectResponse> {
  const meta = MUTATION_META[request.type];
  audit.record("request.started", meta.started);
  try {
    await audit.persist();
  } catch {
    return { type: "response", requestId: request.requestId, ok: false, code: "unavailable",
      message: "The audit record could not be saved. No remote action was sent." };
  }
  const uncertain = (): PrivateConnectResponse => ({
    type: "response", requestId: request.requestId, ok: false, code: "uncertain",
    message: "The remote action acknowledgement is uncertain. Check the desktop conversation before trying again.",
  });
  let response: PrivateConnectResponse;
  try {
    response = await audit.dispatch();
  } catch {
    audit.record("request.uncertain", "A remote action lost its runtime acknowledgement.");
    await audit.persist().catch(() => undefined);
    return uncertain();
  }
  if (response.ok) {
    const kind = response.result && typeof response.result === "object" && "kind" in response.result
      ? response.result.kind : null;
    if (kind !== meta.expectedKind) {
      audit.record("request.uncertain", "A remote action returned an unexpected acknowledgement.");
      await audit.persist().catch(() => undefined);
      return uncertain();
    }
    audit.record(meta.acceptedType, meta.acceptedDetail);
  } else {
    audit.record("request.rejected", "A remote action was rejected by the runtime.");
  }
  try {
    await audit.persist();
  } catch {
    return response.ok ? uncertain() : response;
  }
  return response;
}
