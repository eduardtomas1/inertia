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

export async function runAuditedPrivateConnectMutation(
  request: Extract<PrivateConnectRequest, { type: "input.respond" | "run.stop" }>,
  audit: MutationAudit,
): Promise<PrivateConnectResponse> {
  const answering = request.type === "input.respond";
  audit.record("request.started", answering ? "A remote answer was requested." : "A remote stop was requested.");
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
    if (kind !== (answering ? "input.accepted" : "run.stopped")) {
      audit.record("request.uncertain", "A remote action returned an unexpected acknowledgement.");
      await audit.persist().catch(() => undefined);
      return uncertain();
    }
    audit.record(answering ? "input.accepted" : "run.stop-accepted",
      answering ? "A remote answer was accepted." : "A remote stop request was accepted.");
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
