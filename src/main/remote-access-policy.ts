import { createHash } from "node:crypto";

import type { RawData } from "ws";

import { remoteGrantsNeedReview } from "../shared/remote-grants";
import {
  REMOTE_DESKTOP_VERSION,
  type RemoteAccessState,
  type RemoteCipherFrame,
  type RemotePairingInvitation,
  type RemoteRequest,
  type RemoteSetupDiagnostics,
  type RemoteScope,
} from "../shared/remote-protocol";
import type {
  PersistedRemoteAccess,
  PersistedRemoteDevice,
} from "./remote-access-store";
import type { PendingRemotePairing } from "./remote-access-service-types";

export const MINUTE_MS = 60_000;
export const MAX_REMOTE_GRANT_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEFAULT_REMOTE_GRANT_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_REMOTE_PROMPT_GRANT_MS = 7 * 24 * 60 * 60 * 1_000;

export function boundedRemoteGrantMs(
  requestedMs: number,
  scopes: readonly RemoteScope[],
): number {
  const ceiling = scopes.includes("prompt")
    ? MAX_REMOTE_PROMPT_GRANT_MS
    : MAX_REMOTE_GRANT_MS;
  return Math.min(Math.trunc(requestedMs), ceiling);
}
export const DEFAULT_REMOTE_RELAY_URL = "ws://127.0.0.1:8787/remote";
export const DEFAULT_REMOTE_COMPANION_URL = "http://127.0.0.1:4173/";

export function emptyRemoteSetupDiagnostics(): RemoteSetupDiagnostics {
  return {
    status: "untested",
    testedAt: null,
    transport: null,
    tls: null,
    originPolicy: "unknown",
    relayVersion: null,
    browserVersion: null,
    desktopVersion: REMOTE_DESKTOP_VERSION,
    relayProtocol: null,
    remoteProtocol: null,
    endpointAuthentication: null,
    persistence: null,
    endpointOwnership: "unclaimed",
    endpointEpoch: null,
    lastConnectedAt: null,
    retryClass: "none",
    failureClass: "none",
    message: null,
  };
}

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
  code: "invalid-message" | "desktop-offline"
    | "connection-missing" | "capacity" | "rate-limited"
    | "challenge-expired" | "endpoint-missing" | "endpoint-owned"
    | "proof-invalid" | "storage-unavailable",
): string {
  if (code === "desktop-offline") return "The desktop is offline.";
  if (code === "capacity") return "The relay is at capacity.";
  if (code === "rate-limited") return "The relay is rate limiting connections.";
  if (code === "endpoint-owned") {
    return "The relay endpoint is owned by another signing key.";
  }
  if (code === "endpoint-missing") {
    return "The relay lost this endpoint binding. Create a fresh endpoint and re-pair.";
  }
  if (code === "storage-unavailable") {
    return "The relay could not persist endpoint ownership.";
  }
  if (code === "challenge-expired" || code === "proof-invalid") {
    return "Relay endpoint authentication failed.";
  }
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
  diagnostics?: RemoteSetupDiagnostics;
}): RemoteAccessState {
  const { data } = input;
  const diagnostics = input.diagnostics ?? emptyRemoteSetupDiagnostics();
  const relayBinding = data?.relayBinding ?? null;
  return {
    available: input.storageAvailable && input.storeError === null,
    enabled: data?.enabled ?? false,
    relayUrl: data?.relayUrl
      ?? (input.storageAvailable ? DEFAULT_REMOTE_RELAY_URL : ""),
    setupMode: data?.setupMode ?? "local-development",
    companionUrl: data?.companionUrl ?? DEFAULT_REMOTE_COMPANION_URL,
    diagnostics: {
      ...diagnostics,
      endpointOwnership: diagnostics.endpointOwnership === "missing"
          || diagnostics.endpointOwnership === "owned-by-another-key"
        ? diagnostics.endpointOwnership
        : relayBinding ? "verified" : "unclaimed",
      endpointEpoch: relayBinding?.epoch ?? null,
      lastConnectedAt: relayBinding?.connectedAt
        ?? relayBinding?.lastConnectedAt ?? null,
      retryClass: diagnostics.retryClass !== "manual"
          && data?.enabled && input.connection !== "online"
        ? "automatic"
        : diagnostics.retryClass,
    },
    connection: data?.enabled ? input.connection : "disabled",
    connectionMessage: input.storeError ?? input.connectionMessage,
    activeSessions: input.activeSessions,
    devices: (data?.devices ?? []).map((device) => ({
      id: device.id,
      label: device.label,
      scopes: [...device.scopes],
      projectIds: [...device.projectIds],
      grants: structuredClone(device.grants),
      needsGrantReview: remoteGrantsNeedReview(device.grants),
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
      replacesDeviceLabel: data?.devices.find(
        ({ id }) => id === pending.payload.deviceId,
      )?.label ?? null,
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
