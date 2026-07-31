import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { generateRemoteKeyPair } from "../../src/shared/remote-crypto";
import { REMOTE_LIMITS } from "../../src/shared/remote-protocol";
import {
  createRemoteStoreEncryption,
  RemoteAccessStore,
  type PersistedRemoteAccess,
  type PersistedRemoteDevice,
} from "../../src/main/remote-access-store";
import { FileCredentialVaultPersistence } from "../../src/main/credential-vault";
import { applyRemotePairingGrant } from "../../src/main/remote-access-devices";
import {
  remoteConversationGrantsFromProjectIds,
  remoteGrantAllowsConversation,
} from "../../src/shared/remote-grants";

const temporaryDirectories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-remote-store-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "remote.vault");
  const encryption = {
    available: () => true,
    encrypt: (plaintext: string) =>
      new TextEncoder().encode(
        `test-ciphertext:${btoa(plaintext)}`,
      ),
    decrypt: (ciphertext: Uint8Array) => atob(
      new TextDecoder().decode(ciphertext).replace("test-ciphertext:", ""),
    ),
  };
  const reopen = () => new RemoteAccessStore(file, encryption);
  return { directory, file, store: reopen(), reopen };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Remote Companion encrypted local store", () => {
  it("preserves legacy project-wide access when pairing omits grants", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const projectId = crypto.randomUUID();
    const data: PersistedRemoteAccess = {
      version: 1,
      enabled: false,
      relayUrl: "ws://127.0.0.1:8787/remote",
      hostId: crypto.randomUUID(),
      endpointId: "legacy_pairing_endpoint",
      keyPair: { publicKey: "host_public", privateKey: "host_private" },
      devices: [],
      audit: [],
      receipts: [],
      usedSessions: [],
    };

    const { device } = applyRemotePairingGrant({
      data,
      pending: {
        connectionId: "connection",
        connectionEpoch: 1,
        payload: {
          type: "pair.request",
          requestId: crypto.randomUUID(),
          invitationId: crypto.randomUUID(),
          deviceId: crypto.randomUUID(),
          deviceLabel: "Legacy browser",
          devicePublicKey: "legacy_public_key",
          createdAt: now.toISOString(),
          browserVersion: "0.1.0",
        },
        receivedAt: now.toISOString(),
        expiresAt: "2030-01-01T00:05:00.000Z",
        comparisonCode: "123456",
      },
      scopes: ["view"],
      projectIds: [projectId],
      grantMs: 60_000,
      now,
    });

    expect(device.grants).toEqual([expect.objectContaining({
      projectId,
      conversationIds: [],
      includeFutureConversations: false,
      legacyProjectWide: true,
    })]);
    expect(remoteGrantAllowsConversation(
      device.grants,
      projectId,
      crypto.randomUUID(),
    )).toBe(true);
  });

  it("persists private keys and audit metadata only through encryption", async () => {
    const { file, store } = fixture();
    const keyPair = await generateRemoteKeyPair();
    const value: PersistedRemoteAccess = {
      version: 1,
      enabled: false,
      relayUrl: "ws://127.0.0.1:8787/remote",
      hostId: crypto.randomUUID(),
      endpointId: "opaque_endpoint",
      keyPair,
      devices: [],
      audit: [{
        id: crypto.randomUUID(),
        type: "remote.disabled",
        deviceId: null,
        detail: "Remote Companion disabled.",
        createdAt: new Date().toISOString(),
      }],
      receipts: [],
      usedSessions: [],
    };

    await store.save(value);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(keyPair.privateKey);
    expect(raw).not.toContain("Remote Companion disabled");
    expect(await store.load()).toEqual(value);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("does not operate when platform encryption is unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-remote-store-"));
    temporaryDirectories.push(directory);
    const store = new RemoteAccessStore(join(directory, "remote.vault"), {
      available: () => false,
      encrypt: () => new Uint8Array(),
      decrypt: () => "",
    });
    expect(store.available()).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it.each(["basic_text", "unknown"])(
    "rejects the Linux %s safeStorage backend",
    async (backend) => {
      const storage = {
        getSelectedStorageBackend: vi.fn(() => backend),
        isAsyncEncryptionAvailable: vi.fn(async () => true),
        encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value)),
        decryptStringAsync: vi.fn(async (value: Buffer) => ({
          result: value.toString("utf8"),
          shouldReEncrypt: false,
        })),
        encryptString: vi.fn((value: string) => Buffer.from(value)),
        decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
      };
      const encryption = await createRemoteStoreEncryption(
        storage as never,
        "linux",
      );

      expect(encryption.available()).toBe(false);
      expect(() => encryption.encrypt("private-key")).toThrow(
        "Secure platform storage is unavailable.",
      );
      expect(storage.encryptString).not.toHaveBeenCalled();
    },
  );

  it("fails closed without blocking startup when platform storage stalls", async () => {
    vi.useFakeTimers();
    const encryptionPromise = createRemoteStoreEncryption({
      getSelectedStorageBackend: vi.fn(() => "keychain"),
      isAsyncEncryptionAvailable: vi.fn(
        async () => await new Promise<boolean>(() => undefined),
      ),
      encryptStringAsync: vi.fn(),
      decryptStringAsync: vi.fn(),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    } as never, "darwin", 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    const encryption = await encryptionPromise;
    expect(encryption.available()).toBe(false);
    expect(() => encryption.encrypt("private-key")).toThrow(
      "Secure platform storage is unavailable.",
    );
  });

  it("recovers a unique interrupted remote-vault replacement on restart", async () => {
    const { directory, file, store } = fixture();
    const keyPair = await generateRemoteKeyPair();
    const value: PersistedRemoteAccess = {
      version: 1,
      enabled: false,
      relayUrl: "ws://127.0.0.1:8787/remote",
      hostId: crypto.randomUUID(),
      endpointId: "recovered_endpoint",
      keyPair,
      devices: [],
      audit: [],
      receipts: [],
      usedSessions: [],
    };
    await store.save(value);
    const encoded = readFileSync(file, "utf8");
    const token = crypto.randomUUID();
    const stage = join(
      directory,
      `.remote-access-vault-${token}.stage`,
    );
    const backup = join(
      directory,
      `.remote-access-vault-${token}.backup`,
    );
    renameSync(file, backup);
    writeFileSync(stage, encoded, { mode: 0o600 });

    expect(await store.load()).toEqual(value);
    expect(existsSync(stage)).toBe(false);
    expect(existsSync(backup)).toBe(false);
  });

  it("uses the shared Windows replacement path for a separate remote namespace", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-remote-store-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "remote.vault");
    const persistence = new FileCredentialVaultPersistence(file, {
      platform: "win32",
      temporaryPrefix: ".remote-access-vault-",
    });
    const store = new RemoteAccessStore(file, {
      available: () => true,
      encrypt: (plaintext) => new TextEncoder().encode(plaintext),
      decrypt: (ciphertext) => new TextDecoder().decode(ciphertext),
    }, persistence);
    const first = (await generateRemoteKeyPair());
    const base: PersistedRemoteAccess = {
      version: 1,
      enabled: false,
      relayUrl: "ws://127.0.0.1:8787/remote",
      hostId: crypto.randomUUID(),
      endpointId: "windows_endpoint",
      keyPair: first,
      devices: [],
      audit: [],
      receipts: [],
      usedSessions: [],
    };
    await store.save(base);
    await store.save({ ...base, enabled: true });

    expect(await store.load()).toMatchObject({ enabled: true });
    expect(readFileSync(file, "utf8")).not.toContain(first.privateKey);
  });

  it("prunes the oldest retired device before persisting a replacement slot", async () => {
    const { store, reopen } = fixture();
    const now = new Date("2030-01-01T00:00:00.000Z");
    const oldestRetiredId = crypto.randomUUID();
    const expiredId = crypto.randomUUID();
    const devices = Array.from(
      { length: REMOTE_LIMITS.devices },
      (_, index): PersistedRemoteDevice => ({
        id: index === 0
          ? oldestRetiredId
          : index === 1
            ? expiredId
            : crypto.randomUUID(),
        label: `Device ${index}`,
        publicKey: `device_key_${index}`,
        scopes: ["view"],
        projectIds: ["project"],
        grants: remoteConversationGrantsFromProjectIds(["project"]),
        createdAt: new Date(Date.UTC(2028, 0, index + 1)).toISOString(),
        expiresAt: index === 1
          ? "2029-06-01T00:00:00.000Z"
          : "2030-06-01T00:00:00.000Z",
        lastSeenAt: null,
        revokedAt: index === 0
          ? "2029-01-01T00:00:00.000Z"
          : null,
        grantVersion: 1,
      }),
    );
    const value: PersistedRemoteAccess = {
      version: 1,
      enabled: false,
      relayUrl: "ws://127.0.0.1:8787/remote",
      hostId: crypto.randomUUID(),
      endpointId: "bounded_endpoint",
      keyPair: { publicKey: "host_public", privateKey: "host_private" },
      devices,
      audit: [],
      receipts: [],
      usedSessions: [],
    };
    await store.save(value);

    const reopened = reopen();
    const loaded = await reopened.load();
    expect(loaded).not.toBeNull();
    const newDeviceId = crypto.randomUUID();
    applyRemotePairingGrant({
      data: loaded!,
      pending: {
        connectionId: "connection",
        connectionEpoch: 1,
        payload: {
          type: "pair.request",
          requestId: crypto.randomUUID(),
          invitationId: crypto.randomUUID(),
          deviceId: newDeviceId,
          deviceLabel: "Replacement browser",
          devicePublicKey: "replacement_key",
          createdAt: now.toISOString(),
          browserVersion: "0.1.0",
        },
        receivedAt: now.toISOString(),
        expiresAt: "2030-01-01T00:05:00.000Z",
        comparisonCode: "123456",
      },
      scopes: ["view"],
      projectIds: ["project"],
      grantMs: 60_000,
      now,
    });
    await reopened.save(loaded!);
    const persisted = await reopen().load();

    expect(persisted?.devices).toHaveLength(REMOTE_LIMITS.devices);
    expect(persisted?.devices.map(({ id }) => id)).not.toContain(
      oldestRetiredId,
    );
    expect(persisted?.devices.map(({ id }) => id)).toContain(expiredId);
    expect(persisted?.devices.map(({ id }) => id)).toContain(newDeviceId);
  });

  it("does not mutate a full list of active devices", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const data: PersistedRemoteAccess = {
      version: 1,
      enabled: false,
      relayUrl: "ws://127.0.0.1:8787/remote",
      hostId: crypto.randomUUID(),
      endpointId: "full_endpoint",
      keyPair: { publicKey: "host_public", privateKey: "host_private" },
      devices: Array.from(
        { length: REMOTE_LIMITS.devices },
        (_, index) => ({
          id: crypto.randomUUID(),
          label: `Active ${index}`,
          publicKey: `active_key_${index}`,
          scopes: ["view" as const],
          projectIds: ["project"],
          grants: remoteConversationGrantsFromProjectIds(["project"]),
          createdAt: "2029-01-01T00:00:00.000Z",
          expiresAt: "2030-06-01T00:00:00.000Z",
          lastSeenAt: null,
          revokedAt: null,
          grantVersion: 1,
        }),
      ),
      audit: [],
      receipts: [],
      usedSessions: [],
    };
    const before = structuredClone(data.devices);

    expect(() => applyRemotePairingGrant({
      data,
      pending: {
        connectionId: "connection",
        connectionEpoch: 1,
        payload: {
          type: "pair.request",
          requestId: crypto.randomUUID(),
          invitationId: crypto.randomUUID(),
          deviceId: crypto.randomUUID(),
          deviceLabel: "Blocked browser",
          devicePublicKey: "blocked_key",
          createdAt: now.toISOString(),
          browserVersion: "0.1.0",
        },
        receivedAt: now.toISOString(),
        expiresAt: "2030-01-01T00:05:00.000Z",
        comparisonCode: "123456",
      },
      scopes: ["view"],
      projectIds: ["project"],
      grantMs: 60_000,
      now,
    })).toThrow("paired-device limit");
    expect(data.devices).toEqual(before);
  });
});
