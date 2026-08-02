import { describe, expect, it, vi } from "vitest";

import { generateRemoteKeyPair } from "../../src/shared/remote-crypto";
import { emptyRemoteSetupDiagnostics } from "../../src/main/remote-access-policy";
import { RemoteAccessSetupManager } from "../../src/main/remote-access-setup-manager";
import type { PersistedRemoteAccess } from "../../src/main/remote-access-store";

const NOW = new Date("2032-01-02T03:04:05.000Z");
const RELAY_IDENTITY = "40e581f4-afc6-4eb3-b663-f0ce27f07145";

describe("Remote Companion setup manager", () => {
  it("journals an endpoint reset before reducing live authority", async () => {
    const data = await persistedAccess();
    data.relayBinding = {
      relayIdentity: "8d674298-ed1d-4abc-a8cc-b11f2dca0a91",
      epoch: 3,
      lastConnectedAt: NOW.toISOString(),
      connectedAt: NOW.toISOString(),
    };
    const previousEndpointId = data.endpointId;
    const persist = vi.fn(async () => undefined);
    const persistAuthorityReduction = vi.fn(async (mutate: () => void) => {
      expect(data.enabled).toBe(true);
      mutate();
      expect(data.enabled).toBe(false);
    });
    const manager = setupManager(
      data,
      persist,
      persistAuthorityReduction,
    );

    await manager.test(
      "wss://relay.example/remote",
      "https://companion.example/",
      "self-hosted",
      true,
    );

    expect(persistAuthorityReduction).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
    expect(data.endpointId).not.toBe(previousEndpointId);
    expect(data.relayBinding).toBeNull();
    expect(data.devices[0]).toMatchObject({
      revokedAt: NOW.toISOString(),
      grantVersion: 2,
    });
  });

  it("honors an explicit reset when the local relay binding is missing", async () => {
    const data = await persistedAccess();
    data.relayBinding = null;
    const previousEndpointId = data.endpointId;
    const persistAuthorityReduction = vi.fn(async (mutate: () => void) => {
      mutate();
    });
    const manager = setupManager(
      data,
      vi.fn(async () => undefined),
      persistAuthorityReduction,
    );

    await manager.test(
      "wss://relay.example/remote",
      "https://companion.example/",
      "self-hosted",
      true,
    );

    expect(persistAuthorityReduction).toHaveBeenCalledOnce();
    expect(data.endpointId).not.toBe(previousEndpointId);
    expect(data.endpointKeyPair).not.toBeNull();
  });

  it.each([
    [
      "endpoint-missing",
      "missing",
      "The relay lost this endpoint binding. Create a fresh endpoint and re-pair.",
    ],
    [
      "endpoint-owned",
      "owned-by-another-key",
      "The relay endpoint is owned by another signing key.",
    ],
  ] as const)(
    "keeps %s recovery actionable across an ownership-blind setup probe",
    async (code, endpointOwnership, message) => {
      const data = await persistedAccess();
      const previousEndpointId = data.endpointId;
      const persistAuthorityReduction = vi.fn(async (mutate: () => void) => {
        mutate();
      });
      const manager = setupManager(
        data,
        vi.fn(async () => undefined),
        persistAuthorityReduction,
      );

      manager.relayError(code, message);
      await expect(manager.test(
        "wss://relay.example/remote",
        "https://companion.example/",
        "self-hosted",
      )).rejects.toThrow(message);
      expect(manager.current()).toMatchObject({
        status: "failed",
        endpointOwnership,
        retryClass: "manual",
        failureClass: "endpoint-authentication",
        message,
      });
      expect(persistAuthorityReduction).not.toHaveBeenCalled();

      await manager.test(
        "wss://relay.example/remote",
        "https://companion.example/",
        "self-hosted",
        true,
      );
      expect(persistAuthorityReduction).toHaveBeenCalledOnce();
      expect(data.endpointId).not.toBe(previousEndpointId);
      expect(manager.current()).toMatchObject({
        status: "passed",
        endpointOwnership: "unclaimed",
        failureClass: "none",
      });
    },
  );
});

function setupManager(
  data: PersistedRemoteAccess,
  persist: () => Promise<void>,
  persistAuthorityReduction: (mutate: () => void) => Promise<void>,
): RemoteAccessSetupManager {
  return new RemoteAccessSetupManager({
    data: () => data,
    initializeIdentity: async () => data,
    serialize: async (operation) => await operation(),
    persist,
    persistAuthorityReduction,
    disableLiveAccess: () => undefined,
    audit: () => undefined,
    now: () => NOW,
    emit: () => undefined,
    probe: async () => ({
      relayUrl: "wss://relay.example/remote",
      companionUrl: "https://companion.example/",
      relayIdentity: RELAY_IDENTITY,
      diagnostics: {
        ...emptyRemoteSetupDiagnostics(),
        status: "passed",
      },
    }),
  });
}

async function persistedAccess(): Promise<PersistedRemoteAccess> {
  return {
    version: 1,
    enabled: true,
    relayUrl: "wss://old-relay.example/remote",
    hostId: "0fa47e3d-d8a2-4515-a7ee-52481a053840",
    endpointId: "old_endpoint",
    keyPair: await generateRemoteKeyPair(),
    endpointKeyPair: null,
    setupMode: "self-hosted",
    companionUrl: "https://old-companion.example/",
    endpointAuthMigratedAt: null,
    relayBinding: null,
    devices: [{
      id: "cc15130c-c6fc-4050-89cb-63027647cf0c",
      label: "Test browser",
      publicKey: "device_public_key",
      scopes: ["view"],
      projectIds: ["project"],
      grants: [],
      grantVersion: 1,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    }],
    deviceTombstones: [],
    audit: [],
    receipts: [],
    usedSessions: [],
  };
}
