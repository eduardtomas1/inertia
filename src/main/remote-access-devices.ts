import {
  REMOTE_LIMITS,
  type RemoteScope,
} from "../shared/remote-protocol";
import {
  MAX_REMOTE_GRANT_MS,
  MINUTE_MS,
  normalizeRemoteProjectIds,
  normalizeRemoteScopes,
} from "./remote-access-policy";
import type {
  PersistedRemoteAccess,
  PersistedRemoteDevice,
} from "./remote-access-store";
import type { PendingRemotePairing } from "./remote-access-service-types";

export function applyRemotePairingGrant(input: {
  data: PersistedRemoteAccess;
  pending: PendingRemotePairing;
  scopes: RemoteScope[];
  projectIds: string[];
  grantMs: number;
  now: Date;
}): PersistedRemoteDevice {
  if (
    input.data.devices.filter(({ revokedAt }) => revokedAt === null).length
    >= REMOTE_LIMITS.devices
  ) throw new Error("The paired-device limit has been reached.");
  const expiresAt = new Date(
    input.now.getTime() + Math.max(
      MINUTE_MS,
      Math.min(Math.trunc(input.grantMs), MAX_REMOTE_GRANT_MS),
    ),
  ).toISOString();
  const device: PersistedRemoteDevice = {
    id: input.pending.payload.deviceId,
    label: input.pending.payload.deviceLabel,
    publicKey: input.pending.payload.devicePublicKey,
    scopes: normalizeRemoteScopes(input.scopes),
    projectIds: normalizeRemoteProjectIds(input.projectIds),
    createdAt: input.now.toISOString(),
    expiresAt,
    lastSeenAt: null,
    revokedAt: null,
    grantVersion: 1,
  };
  const existing = input.data.devices.findIndex(({ id }) => id === device.id);
  if (existing >= 0) {
    const previous = input.data.devices[existing]!;
    device.createdAt = previous.createdAt;
    device.grantVersion = previous.grantVersion + 1;
    input.data.devices[existing] = device;
  } else {
    input.data.devices.push(device);
  }
  return device;
}

export function revokeRemoteDevice(
  data: PersistedRemoteAccess,
  deviceId: string,
  now: Date,
): PersistedRemoteDevice | null {
  const device = requireRemoteDevice(data, deviceId);
  if (device.revokedAt) return null;
  device.revokedAt = now.toISOString();
  device.grantVersion += 1;
  return device;
}

export function updateRemoteDeviceGrant(input: {
  data: PersistedRemoteAccess;
  deviceId: string;
  scopes: RemoteScope[];
  projectIds: string[];
  expiresAt: string;
  now: Date;
}): PersistedRemoteDevice {
  const device = requireRemoteDevice(input.data, input.deviceId);
  const expiry = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(expiry)
    || expiry <= input.now.getTime()
    || expiry > input.now.getTime() + MAX_REMOTE_GRANT_MS
  ) throw new Error("Choose an expiry within 90 days.");
  device.scopes = normalizeRemoteScopes(input.scopes);
  device.projectIds = normalizeRemoteProjectIds(input.projectIds);
  device.expiresAt = new Date(expiry).toISOString();
  device.grantVersion += 1;
  return device;
}

function requireRemoteDevice(
  data: PersistedRemoteAccess,
  deviceId: string,
): PersistedRemoteDevice {
  const device = data.devices.find(({ id }) => id === deviceId);
  if (!device) throw new Error("That paired device was not found.");
  return device;
}
