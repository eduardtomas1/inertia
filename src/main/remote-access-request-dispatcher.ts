import type { PersistedRemoteAccess } from "./remote-access-store";
import {
  acceptRemoteDelivery,
  markRemoteDeliveryUncertain,
  prepareRemoteDelivery,
} from "./remote-access-delivery";
import type {
  ActiveRemoteSession,
  RemoteAccessServiceOptions,
} from "./remote-access-service-types";
import type {
  RemoteAuditEvent,
  RemoteRequest,
  RemoteResponse,
} from "../shared/remote-protocol";

interface RemoteRequestDispatcherOptions {
  runtime: RemoteAccessServiceOptions["runtime"];
  data(): PersistedRemoteAccess;
  now(): Date;
  persist(): Promise<void>;
  audit(
    type: RemoteAuditEvent["type"],
    deviceId: string | null,
    detail: string,
  ): void;
  isCurrent(session: ActiveRemoteSession): boolean;
  respond(session: ActiveRemoteSession, response: RemoteResponse): Promise<void>;
}

export class RemoteRequestDispatcher {
  constructor(private readonly options: RemoteRequestDispatcherOptions) {}

  async dispatch(
    session: ActiveRemoteSession,
    request: RemoteRequest,
  ): Promise<void> {
    try {
      const receiptResponse = request.type === "prompt.send"
        ? await this.prepareDelivery(session, request)
        : null;
      const response = receiptResponse
        ?? await this.options.runtime.remoteRequest(session.subject, request);
      if (request.type === "prompt.send" && response.ok) {
        await this.acceptDelivery(session, request, response);
      }
      if (this.options.isCurrent(session)) {
        await this.options.respond(session, response);
      }
    } catch {
      if (request.type === "prompt.send") {
        await this.markDeliveryUncertain(session, request);
      }
      if (this.options.isCurrent(session)) {
        await this.options.respond(session, {
          type: "response",
          requestId: request.requestId,
          ok: false,
          code: request.type === "prompt.send" ? "uncertain" : "unavailable",
          message: request.type === "prompt.send"
            ? "Prompt delivery is uncertain. Do not retry automatically."
            : "The local runtime is unavailable.",
        });
      }
    } finally {
      session.inFlight.delete(request.requestId);
    }
  }

  private async prepareDelivery(
    session: ActiveRemoteSession,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
  ): Promise<RemoteResponse | null> {
    const prepared = prepareRemoteDelivery(
      this.options.data(),
      session.device.id,
      request,
      this.options.now().toISOString(),
    );
    if (prepared.changed) await this.options.persist();
    return prepared.response;
  }

  private async acceptDelivery(
    session: ActiveRemoteSession,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
    response: RemoteResponse,
  ): Promise<void> {
    if (!acceptRemoteDelivery(this.options.data(), request, response)) return;
    this.options.audit(
      "prompt.accepted",
      session.device.id,
      "A remote text prompt was accepted.",
    );
    await this.options.persist();
  }

  private async markDeliveryUncertain(
    session: ActiveRemoteSession,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
  ): Promise<void> {
    if (!markRemoteDeliveryUncertain(
      this.options.data(),
      request.deliveryId,
    )) return;
    this.options.audit(
      "prompt.uncertain",
      session.device.id,
      "A remote prompt has uncertain delivery.",
    );
    await this.options.persist();
  }
}
