import { randomUUID } from "node:crypto";

import {
  generateRemoteKeyPair,
  importRemoteKeyPair,
  remoteRandomSecret,
  type RemoteImportedKeyPair,
} from "../shared/remote-crypto";
import type {
  PersistedRemoteAccess,
  RemoteAccessStore,
} from "./remote-access-store";
import { generateRemoteEndpointKeyPair } from "./remote-access-endpoint-auth";

export async function createRemoteAccessIdentity(
  store: RemoteAccessStore,
  relayUrl: string,
): Promise<{
  data: PersistedRemoteAccess;
  hostKeyPair: RemoteImportedKeyPair;
}> {
  const keyPair = await generateRemoteKeyPair();
  const hostKeyPair = await importRemoteKeyPair(keyPair);
  const data: PersistedRemoteAccess = {
    version: 1,
    enabled: false,
    relayUrl,
    hostId: randomUUID(),
    endpointId: remoteRandomSecret(24),
    keyPair,
    endpointKeyPair: generateRemoteEndpointKeyPair(),
    setupMode: "local-development",
    companionUrl: "http://127.0.0.1:4173/",
    endpointAuthMigratedAt: null,
    relayBinding: null,
    devices: [],
    deviceTombstones: [],
    audit: [],
    receipts: [],
    usedSessions: [],
  };
  await store.save(data);
  return { data, hostKeyPair };
}

export async function loadRemoteAccessIdentity(
  store: RemoteAccessStore,
): Promise<
  | { kind: "unavailable" | "corrupt"; message: string }
  | { kind: "empty" }
  | {
      kind: "ready";
      data: PersistedRemoteAccess;
      hostKeyPair: RemoteImportedKeyPair;
    }
> {
  if (!store.available()) {
    return {
      kind: "unavailable",
      message: "Secure platform storage is unavailable.",
    };
  }
  try {
    const data = await store.load();
    if (!data) return { kind: "empty" };
    if (data.endpointKeyPair == null) {
      const migratedAt = new Date().toISOString();
      data.enabled = false;
      data.endpointId = remoteRandomSecret(24);
      data.endpointKeyPair = generateRemoteEndpointKeyPair();
      data.endpointAuthMigratedAt = migratedAt;
      data.relayBinding = null;
      for (const device of data.devices) {
        if (device.revokedAt === null) {
          device.revokedAt = migratedAt;
          device.grantVersion += 1;
        }
      }
      data.receipts = [];
      data.usedSessions = [];
    }
    data.receipts = data.receipts.map((receipt) =>
      receipt.state === "dispatched"
        ? { ...receipt, state: "uncertain" }
        : receipt);
    await store.save(data);
    return {
      kind: "ready",
      data,
      hostKeyPair: await importRemoteKeyPair(data.keyPair),
    };
  } catch {
    return {
      kind: "corrupt",
      message: "The encrypted Remote Companion store could not be opened.",
    };
  }
}
