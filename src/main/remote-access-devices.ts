import {
  REMOTE_LIMITS,
  type RemoteScope,
} from "../shared/remote-protocol";
import {
  boundedRemoteGrantMs,
  MAX_REMOTE_GRANT_MS,
  MINUTE_MS,
  normalizeRemoteProjectIds,
  normalizeRemoteScopes,
  remoteDeviceIsCurrent,
} from "./remote-access-policy";
import {
  normalizeRemoteConversationGrants,
  remoteConversationGrantsFromProjectIds,
  remoteGrantedProjectIds,
  type RemoteConversationGrant,
} from "../shared/remote-grants";
import type {
  PersistedRemoteAccess,
  PersistedRemoteDevice,
  PersistedRemoteDeviceTombstone,
} from "./remote-access-store";
import type { PendingRemotePairing } from "./remote-access-service-types";

export function applyRemotePairingGrant(input: {
  data: PersistedRemoteAccess;
  pending: PendingRemotePairing;
  scopes: RemoteScope[];
  projectIds: string[];
  grants?: RemoteConversationGrant[];
  grantMs: number;
  now: Date;
}): { device: PersistedRemoteDevice; replaced: boolean } {
  const scopes = normalizeRemoteScopes(input.scopes);
  const expiresAt = new Date(
    input.now.getTime() + Math.max(
      MINUTE_MS,
      boundedRemoteGrantMs(input.grantMs, scopes),
    ),
  ).toISOString();
  const grants = resolvedGrants(input.projectIds, input.grants);
  const device: PersistedRemoteDevice = {
    id: input.pending.payload.deviceId,
    label: input.pending.payload.deviceLabel,
    publicKey: input.pending.payload.devicePublicKey,
    scopes,
    projectIds: remoteGrantedProjectIds(grants),
    grants,
    createdAt: input.now.toISOString(),
    expiresAt,
    lastSeenAt: null,
    revokedAt: null,
    grantVersion: 1,
  };
  const existing = input.data.devices.findIndex(({ id }) => id === device.id);
  const replaced = existing >= 0;
  if (existing >= 0) {
    const previous = input.data.devices[existing]!;
    device.createdAt = previous.createdAt;
    device.grantVersion = previous.grantVersion + 1;
    input.data.devices[existing] = device;
  } else {
    if (
      input.data.devices.filter((candidate) =>
        remoteDeviceIsCurrent(candidate, input.now.getTime())).length
      >= REMOTE_LIMITS.devices
    ) throw new Error("The paired-device limit has been reached.");
    pruneRetiredDevicesForAppend(input.data, input.now);
    input.data.devices.push(device);
  }
  return { device, replaced };
}

function pruneRetiredDevicesForAppend(
  data: PersistedRemoteAccess,
  now: Date,
): void {
  const removalCount = Math.max(
    0,
    data.devices.length - REMOTE_LIMITS.devices + 1,
  );
  if (removalCount === 0) return;
  const retired = data.devices
    .filter((device) => !remoteDeviceIsCurrent(device, now.getTime()))
    .sort((left, right) =>
      retiredAt(left) - retiredAt(right)
      || Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.id.localeCompare(right.id));
  if (retired.length < removalCount) {
    throw new Error("The paired-device limit has been reached.");
  }
  const removed = new Set(
    retired.slice(0, removalCount).map(({ id }) => id),
  );
  for (const device of retired.slice(0, removalCount)) {
    rememberRemoteDeviceTombstone(data, device, now);
  }
  data.devices = data.devices.filter(({ id }) => !removed.has(id));
}

const REMOTE_TOMBSTONE_RETENTION_MS = 8 * 24 * 60 * 60 * 1_000;
const MAX_REMOTE_TOMBSTONES = 64;

export function rememberRemoteDeviceTombstone(
  data: PersistedRemoteAccess,
  device: PersistedRemoteDevice,
  now: Date,
): PersistedRemoteDeviceTombstone {
  const retiredAt = device.revokedAt ?? device.expiresAt;
  const disposition: PersistedRemoteDeviceTombstone["disposition"] =
    device.revokedAt === null ? "expired" : "revoked";
  const tombstone: PersistedRemoteDeviceTombstone = {
    deviceId: device.id,
    publicKey: device.publicKey,
    grantVersion: device.grantVersion,
    disposition,
    retiredAt,
    retainUntil: new Date(Math.max(
      now.getTime(),
      Date.parse(retiredAt),
    ) + REMOTE_TOMBSTONE_RETENTION_MS).toISOString(),
  };
  data.deviceTombstones = (data.deviceTombstones ?? []).filter(
    ({ deviceId, retainUntil }) =>
      deviceId !== device.id && Date.parse(retainUntil) > now.getTime(),
  );
  data.deviceTombstones.push(tombstone);
  data.deviceTombstones.sort((left, right) =>
    Date.parse(left.retiredAt) - Date.parse(right.retiredAt)
    || left.deviceId.localeCompare(right.deviceId));
  if (data.deviceTombstones.length > MAX_REMOTE_TOMBSTONES) {
    data.deviceTombstones.splice(
      0,
      data.deviceTombstones.length - MAX_REMOTE_TOMBSTONES,
    );
  }
  return tombstone;
}

export function pruneRemoteDeviceTombstones(
  data: PersistedRemoteAccess,
  now: Date,
): boolean {
  const current = data.deviceTombstones ?? [];
  const retained = current.filter(
    ({ retainUntil }) => Date.parse(retainUntil) > now.getTime(),
  );
  if (retained.length === current.length) return false;
  data.deviceTombstones = retained;
  return true;
}

function retiredAt(device: PersistedRemoteDevice): number {
  return Date.parse(device.revokedAt ?? device.expiresAt);
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
  grants?: RemoteConversationGrant[];
  expiresAt: string;
  now: Date;
}): PersistedRemoteDevice {
  const device = requireRemoteDevice(input.data, input.deviceId);
  const scopes = normalizeRemoteScopes(input.scopes);
  const expiry = Date.parse(input.expiresAt);
  const ceiling = input.now.getTime()
    + boundedRemoteGrantMs(MAX_REMOTE_GRANT_MS, scopes);
  if (
    !Number.isFinite(expiry)
    || expiry <= input.now.getTime()
    || expiry > ceiling
  ) {
    throw new Error(scopes.includes("prompt")
      ? "Choose an expiry within 7 days for a prompt-capable device."
      : "Choose an expiry within 90 days.");
  }
  const grants = resolvedGrants(
    input.projectIds,
    input.grants ?? retainedGrants(device, input.projectIds),
  );
  device.scopes = scopes;
  device.grants = grants;
  device.projectIds = remoteGrantedProjectIds(grants);
  device.expiresAt = new Date(expiry).toISOString();
  device.grantVersion += 1;
  return device;
}

function retainedGrants(
  device: PersistedRemoteDevice,
  projectIds: string[],
): RemoteConversationGrant[] {
  const requested = new Set(normalizeRemoteProjectIds(projectIds));
  return device.grants.filter(({ projectId }) => requested.has(projectId));
}

function resolvedGrants(
  projectIds: string[],
  grants: RemoteConversationGrant[] | undefined,
): RemoteConversationGrant[] {
  if (grants === undefined) {
    return remoteConversationGrantsFromProjectIds(projectIds);
  }
  const allowed = new Set(normalizeRemoteProjectIds(projectIds));
  const normalized = normalizeRemoteConversationGrants(
    grants.filter(({ projectId }) => allowed.has(projectId)),
  );
  const covered = new Set(normalized.map(({ projectId }) => projectId));
  const missing = [...allowed].filter((projectId) => !covered.has(projectId));
  return normalizeRemoteConversationGrants([
    ...normalized,
    ...missing.map((projectId) => ({
      projectId,
      conversationIds: [],
      includeFutureConversations: false,
      legacyProjectWide: false,
    })),
  ]);
}

function requireRemoteDevice(
  data: PersistedRemoteAccess,
  deviceId: string,
): PersistedRemoteDevice {
  const device = data.devices.find(({ id }) => id === deviceId);
  if (!device) throw new Error("That paired device was not found.");
  return device;
}
