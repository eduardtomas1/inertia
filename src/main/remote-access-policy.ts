import { createHash } from "node:crypto";

import type { RawData } from "ws";

import type {
  RemoteAccessState,
  RemoteCipherFrame,
  RemotePairingInvitation,
  RemoteRequest,
  RemoteScope,
} from "../shared/remote-protocol";
import type {
  PersistedRemoteAccess,
  PersistedRemoteDevice,
} from "./remote-access-store";
import type { PendingRemotePairing } from "./remote-access-service-types";

export const MINUTE_MS = 60_000;
export const MAX_REMOTE_GRANT_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEFAULT_REMOTE_GRANT_MS = 30 * 24 * 60 * 60 * 1_000;

export function validateRemoteRelayUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.hash) {
    throw new Error("Relay URLs cannot contain credentials or fragments.");
  }
  const loopback = url.hostname === "127.0.0.1"
    || url.hostname === "localhost"
    || url.hostname === "[::1]";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("Use wss://, or ws:// only for a loopback development relay.");
  }
  return url.toString();
}

export function normalizeRemoteScopes(scopes: RemoteScope[]): RemoteScope[] {
  const normalized: RemoteScope[] = ["view"];
  if (scopes.includes("prompt")) normalized.push("prompt");
  return normalized;
}

export function normalizeRemoteProjectIds(projectIds: string[]): string[] {
  const normalized = [...new Set(projectIds.map((id) => id.trim()))]
    .filter((id) => id.length > 0 && id.length <= 200)
    .slice(0, 64);
  if (normalized.length === 0) {
    throw new Error("Choose at least one project for this device.");
  }
  return normalized;
}

export function remotePairingComparisonCode(
  hostPublicKey: string,
  devicePublicKey: string,
  invitationId: string,
): string {
  const digest = createHash("sha256")
    .update("inertia-remote-pairing-code\0")
    .update(hostPublicKey)
    .update("\0")
    .update(devicePublicKey)
    .update("\0")
    .update(invitationId)
    .digest();
  return (digest.readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
}

export function remoteDeliveryDigest(
  deviceId: string,
  request: Extract<RemoteRequest, { type: "prompt.send" }>,
): string {
  return createHash("sha256")
    .update("inertia-remote-delivery\0")
    .update(deviceId)
    .update("\0")
    .update(request.conversationId)
    .update("\0")
    .update(request.content)
    .digest("hex");
}

export function remoteDeviceIsCurrent(
  device: PersistedRemoteDevice,
  now: number,
): boolean {
  return device.revokedAt === null && Date.parse(device.expiresAt) > now;
}

export function takeRemoteRate(
  times: number[],
  maximum: number,
  now: number,
): boolean {
  while (times.length > 0 && times[0]! <= now - MINUTE_MS) times.shift();
  if (times.length >= maximum) return false;
  times.push(now);
  return true;
}

export function trimRemoteSet(values: Set<string>, maximum: number): void {
  while (values.size > maximum) {
    const oldest = values.values().next().value;
    if (typeof oldest === "string") values.delete(oldest);
  }
}

export function trimRemoteArray<T>(values: T[], maximum: number): void {
  if (values.length > maximum) values.splice(0, values.length - maximum);
}

export function remoteRelayErrorMessage(
  code: "invalid-message" | "not-registered" | "desktop-offline"
    | "connection-missing" | "capacity" | "rate-limited",
): string {
  if (code === "desktop-offline") return "The desktop is offline.";
  if (code === "capacity") return "The relay is at capacity.";
  if (code === "rate-limited") return "The relay is rate limiting connections.";
  return "The relay rejected a protocol message.";
}

export function projectRemoteAccessState(input: {
  data: PersistedRemoteAccess | null;
  storageAvailable: boolean;
  storeError: string | null;
  connection: RemoteAccessState["connection"];
  connectionMessage: string | null;
  activeSessions: number;
  pendingPairings: Iterable<PendingRemotePairing>;
  invitation: RemotePairingInvitation | null;
}): RemoteAccessState {
  const { data } = input;
  return {
    available: input.storageAvailable && input.storeError === null,
    enabled: data?.enabled ?? false,
    relayUrl: data?.relayUrl
      ?? (input.storageAvailable ? "ws://127.0.0.1:8787" : ""),
    connection: data?.enabled ? input.connection : "disabled",
    connectionMessage: input.storeError ?? input.connectionMessage,
    activeSessions: input.activeSessions,
    devices: (data?.devices ?? []).map((device) => ({
      id: device.id,
      label: device.label,
      scopes: [...device.scopes],
      projectIds: [...device.projectIds],
      createdAt: device.createdAt,
      expiresAt: device.expiresAt,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt,
    })),
    pendingPairings: [...input.pendingPairings].map((pending) => ({
      requestId: pending.payload.requestId,
      deviceLabel: pending.payload.deviceLabel,
      comparisonCode: pending.comparisonCode,
      receivedAt: pending.receivedAt,
      expiresAt: pending.expiresAt,
    })),
    invitation: input.invitation,
    audit: (data?.audit ?? []).slice(-100).reverse(),
  };
}

export function remoteRawDataByteLength(raw: RawData): number {
  return Array.isArray(raw)
    ? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
    : raw.byteLength;
}

export function remoteRawDataText(raw: RawData): string {
  return Array.isArray(raw)
    ? Buffer.concat(raw).toString("utf8")
    : raw.toString();
}

export type RemoteSessionCloseReason = Extract<
  RemoteCipherFrame,
  { kind: "session.close" }
>["reason"];
