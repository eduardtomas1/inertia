import { createHash } from "node:crypto";
import type {
  PrivateConnectRequest,
  PrivateConnectResponse,
} from "../../shared/private-connect/protocol";
import type { PrivateConnectScope } from "../../shared/private-connect/scopes";
import type {
  PrivateConnectRuntimeAuthorization,
  PrivateConnectRuntimeRequest,
  PrivateConnectRuntimeResponse,
} from "../../shared/private-connect/runtime-contract";
import { runAuditedPrivateConnectMutation } from "./audit";
import { adaptPrivateConnectRuntimeResponse } from "./runtime-response";
import type { PrivateConnectAuditEvent, PrivateConnectDevice } from "./store";

export type PrivateConnectQueueRequest = Extract<
  PrivateConnectRequest,
  { type: "queue.send" | "queue.edit" | "queue.remove" | "queue.resume" }
>;

export type PrivateConnectRuntimeQueueRequest = Extract<
  PrivateConnectRuntimeRequest,
  { type: "queue.send" | "queue.edit" | "queue.remove" | "queue.resume" }
>;

export function isPrivateConnectQueueRequest(
  request: PrivateConnectRequest,
): request is PrivateConnectQueueRequest {
  return request.type === "queue.send"
    || request.type === "queue.edit"
    || request.type === "queue.remove"
    || request.type === "queue.resume";
}

export function privateConnectRequiredScope(
  type: PrivateConnectRequest["type"],
): PrivateConnectScope {
  if (
    type === "state.get"
    || type === "conversation.get"
    || type === "client.ping"
    || type === "session.logout"
  ) {
    return "private:read";
  }
  if (
    type === "prompt.send"
    || type === "queue.send"
    || type === "queue.edit"
    || type === "queue.remove"
    || type === "queue.resume"
  ) {
    return "private:prompt";
  }
  if (type === "input.respond") return "private:input";
  return "private:stop";
}

export function isQueuedPromptAcceptedResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as { kind?: unknown; turnId?: unknown; queuedMessageId?: unknown };
  return record.kind === "prompt.accepted"
    && (record.turnId === null || typeof record.queuedMessageId === "string");
}

function toRuntimeQueueRequest(
  request: PrivateConnectQueueRequest,
): PrivateConnectRuntimeQueueRequest {
  switch (request.type) {
    case "queue.send":
      return {
        type: "queue.send",
        requestId: request.requestId,
        conversationId: request.conversationId,
        id: request.id,
      };
    case "queue.edit":
      return {
        type: "queue.edit",
        requestId: request.requestId,
        conversationId: request.conversationId,
        id: request.id,
        expectedRevision: request.expectedRevision,
        content: request.content,
      };
    case "queue.remove":
      return {
        type: "queue.remove",
        requestId: request.requestId,
        conversationId: request.conversationId,
        id: request.id,
      };
    case "queue.resume":
      return {
        type: "queue.resume",
        requestId: request.requestId,
        conversationId: request.conversationId,
      };
  }
}

export interface PrivateConnectQueueDispatchDependencies {
  device: PrivateConnectDevice;
  requireCurrentSession(): void;
  runtimeAuthorization(): PrivateConnectRuntimeAuthorization;
  sendToRuntime(
    subject: PrivateConnectRuntimeAuthorization,
    request: PrivateConnectRuntimeQueueRequest,
  ): Promise<PrivateConnectRuntimeResponse>;
  record(type: PrivateConnectAuditEvent["type"], detail: string): void;
  persist(): Promise<void>;
}

export async function dispatchPrivateConnectQueueRequest(
  request: PrivateConnectQueueRequest,
  dependencies: PrivateConnectQueueDispatchDependencies,
): Promise<PrivateConnectResponse> {
  return await runAuditedPrivateConnectMutation(request, {
    record: dependencies.record,
    persist: dependencies.persist,
    dispatch: async () => {
      dependencies.requireCurrentSession();
      const response = await dependencies.sendToRuntime(
        dependencies.runtimeAuthorization(),
        toRuntimeQueueRequest(request),
      );
      return adaptPrivateConnectRuntimeResponse(response, dependencies.device);
    },
  });
}

export function privateConnectContentDigest(value: string): string {
  return createHash("sha256").update("inertia-private-connect-delivery\0").update(value).digest("hex");
}

export function privateConnectCookieDigest(value: string): string {
  return createHash("sha256").update("inertia-private-connect-cookie\0").update(value).digest("hex");
}

export function privateConnectComparisonCode(hostId: string, deviceId: string, invitationId: string): string {
  return (createHash("sha256")
    .update("inertia-private-connect-pairing\0")
    .update(hostId).update("\0")
    .update(deviceId).update("\0")
    .update(invitationId)
    .digest().readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
}

export function sanitizePrivateConnectError(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 300) || "The request was rejected.";
}

export function withPrivateConnectDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Private Connect authority change timed out safely.")), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function dispatchPrivateConnectLifecycleRequest(
  request: Extract<PrivateConnectRequest, { type: "input.respond" | "run.stop" }>,
  dependencies: Omit<PrivateConnectQueueDispatchDependencies, "sendToRuntime"> & {
    sendToRuntime(
      subject: PrivateConnectRuntimeAuthorization,
      request: Extract<PrivateConnectRuntimeRequest, { type: "input.respond" | "run.stop" }>,
    ): Promise<PrivateConnectRuntimeResponse>;
  },
): Promise<PrivateConnectResponse> {
  return await runAuditedPrivateConnectMutation(request, {
    record: dependencies.record,
    persist: dependencies.persist,
    dispatch: async () => {
      dependencies.requireCurrentSession();
      const runtimeRequest: Extract<PrivateConnectRuntimeRequest, { type: "input.respond" | "run.stop" }> =
        request.type === "input.respond"
          ? { type: "input.respond", requestId: request.requestId, conversationId: request.conversationId, inputRequestId: request.inputRequestId, answers: request.answers }
          : { type: "run.stop", requestId: request.requestId, conversationId: request.conversationId, runId: request.runId };
      const response = await dependencies.sendToRuntime(dependencies.runtimeAuthorization(), runtimeRequest);
      return adaptPrivateConnectRuntimeResponse(response, dependencies.device);
    },
  });
}
