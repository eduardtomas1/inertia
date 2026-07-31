import type { PersistedRemoteAccess } from "./remote-access-store";
import {
  acceptRemoteDelivery,
  cancelRemoteDelivery,
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
  authorizePromptCommit(
    session: ActiveRemoteSession,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
  ): boolean;
  respond(session: ActiveRemoteSession, response: RemoteResponse): Promise<void>;
}

export class RemoteRequestDispatcher {
  constructor(private readonly options: RemoteRequestDispatcherOptions) {}

  async dispatch(
    session: ActiveRemoteSession,
    request: RemoteRequest,
  ): Promise<void> {
    let ownsPromptDelivery = false;
    let promptCommitPosted = false;
    try {
      const receiptResponse = request.type === "prompt.send"
        ? await this.prepareDelivery(session, request)
        : null;
      ownsPromptDelivery =
        request.type === "prompt.send" && receiptResponse === null;
      const response = receiptResponse
        ? await this.revalidatedReceipt(
            session,
            request as Extract<RemoteRequest, { type: "prompt.send" }>,
            receiptResponse,
          )
        : await this.runtimeResponse(
            session,
            request,
            () => {
              if (request.type === "prompt.send") {
                session.postedPromptDeliveries.add(request.deliveryId);
              }
              promptCommitPosted = true;
            },
          );
      if (request.type === "prompt.send" && ownsPromptDelivery) {
        if (response.ok) {
          await this.acceptDelivery(session, request, response);
        } else {
          await this.cancelDelivery(session, request);
        }
      }
      if (this.options.isCurrent(session)) {
        await this.options.respond(session, response);
      }
    } catch {
      if (
        request.type === "prompt.send"
        && ownsPromptDelivery
        && promptCommitPosted
      ) {
        await this.markDeliveryUncertain(session, request);
      } else if (request.type === "prompt.send" && ownsPromptDelivery) {
        await this.cancelDelivery(session, request);
      }
      if (this.options.isCurrent(session)) {
        await this.options.respond(session, {
          type: "response",
          requestId: request.requestId,
          ok: false,
          code: request.type === "prompt.send" && promptCommitPosted
            ? "uncertain"
            : "unavailable",
          message: request.type === "prompt.send" && promptCommitPosted
            ? "Prompt delivery is uncertain. Do not retry automatically."
            : "The local runtime is unavailable.",
        });
      }
    } finally {
      session.inFlight.delete(request.requestId);
      if (request.type === "prompt.send") {
        session.postedPromptDeliveries.delete(request.deliveryId);
      }
    }
  }

  private async runtimeResponse(
    session: ActiveRemoteSession,
    request: RemoteRequest,
    commitPosted: () => void,
  ): Promise<RemoteResponse> {
    if (request.type !== "prompt.send") {
      return await this.options.runtime.remoteRequest(
        session.subject,
        request,
      );
    }
    const prepare = this.options.runtime.prepareRemotePrompt;
    const commit = this.options.runtime.commitRemotePrompt;
    if (!prepare || !commit) {
      throw new Error("The runtime does not support remote prompt commits.");
    }
    const prepared = await prepare.call(
      this.options.runtime,
      session.subject,
      request,
    );
    if (!("preparationId" in prepared)) return prepared;
    if (!this.options.authorizePromptCommit(session, request)) {
      return {
        type: "response",
        requestId: request.requestId,
        ok: false,
        code: "forbidden",
        message: "Remote prompt authority changed before delivery.",
      };
    }
    const response = commit.call(
      this.options.runtime,
      session.subject,
      request,
      prepared.preparationId,
      commitPosted,
    );
    return await response;
  }

  private async revalidatedReceipt(
    session: ActiveRemoteSession,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
    receipt: RemoteResponse,
  ): Promise<RemoteResponse> {
    const prepare = this.options.runtime.prepareRemotePrompt;
    if (!prepare) return receipt;
    const prepared = await prepare.call(
      this.options.runtime,
      session.subject,
      request,
    );
    return "preparationId" in prepared ? receipt : prepared;
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

  private async cancelDelivery(
    session: ActiveRemoteSession,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
  ): Promise<void> {
    if (!cancelRemoteDelivery(
      this.options.data(),
      session.device.id,
      request,
    )) return;
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
