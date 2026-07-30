import {
  REMOTE_LIMITS,
  type RemoteRequest,
  type RemoteResponse,
} from "../shared/remote-protocol";
import type { PersistedRemoteAccess } from "./remote-access-store";
import {
  remoteDeliveryDigest,
  trimRemoteArray,
} from "./remote-access-policy";

type PromptRequest = Extract<RemoteRequest, { type: "prompt.send" }>;

export function prepareRemoteDelivery(
  data: PersistedRemoteAccess,
  deviceId: string,
  request: PromptRequest,
  createdAt: string,
): { response: RemoteResponse | null; changed: boolean } {
  const digest = remoteDeliveryDigest(deviceId, request);
  const receipt = data.receipts.find(
    ({ deliveryId }) => deliveryId === request.deliveryId,
  );
  if (receipt) {
    if (
      receipt.deviceId !== deviceId
      || receipt.conversationId !== request.conversationId
      || receipt.contentDigest !== digest
    ) {
      return {
        changed: false,
        response: {
          type: "response",
          requestId: request.requestId,
          ok: false,
          code: "invalid",
          message: "That delivery identifier was already used.",
        },
      };
    }
    return {
      changed: false,
      response: receipt.state === "accepted" && receipt.turnId
        ? {
            type: "response",
            requestId: request.requestId,
            ok: true,
            result: {
              kind: "prompt.accepted",
              deliveryId: request.deliveryId,
              turnId: receipt.turnId,
            },
          }
        : {
            type: "response",
            requestId: request.requestId,
            ok: false,
            code: "uncertain",
            message: "This prompt may already have been delivered. It was not retried.",
          },
    };
  }
  data.receipts.push({
    deliveryId: request.deliveryId,
    deviceId,
    conversationId: request.conversationId,
    contentDigest: digest,
    state: "dispatched",
    turnId: null,
    createdAt,
  });
  trimRemoteArray(data.receipts, REMOTE_LIMITS.deliveryReceipts);
  return { response: null, changed: true };
}

export function acceptRemoteDelivery(
  data: PersistedRemoteAccess,
  request: PromptRequest,
  response: RemoteResponse,
): boolean {
  if (!response.ok || response.result.kind !== "prompt.accepted") return false;
  const receipt = data.receipts.find(
    ({ deliveryId }) => deliveryId === request.deliveryId,
  );
  if (!receipt) return false;
  receipt.state = "accepted";
  receipt.turnId = response.result.turnId;
  return true;
}

export function markRemoteDeliveryUncertain(
  data: PersistedRemoteAccess,
  deliveryId: string,
): boolean {
  const receipt = data.receipts.find(
    (candidate) => candidate.deliveryId === deliveryId,
  );
  if (!receipt || receipt.state === "accepted") return false;
  receipt.state = "uncertain";
  return true;
}
