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
import {
  createRemoteStoreEncryption,
  RemoteAccessStore,
  type PersistedRemoteAccess,
} from "../../src/main/remote-access-store";
import { FileCredentialVaultPersistence } from "../../src/main/credential-vault";

const temporaryDirectories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-remote-store-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "remote.vault");
  const store = new RemoteAccessStore(file, {
    available: () => true,
    encrypt: (plaintext) =>
      new TextEncoder().encode(
        `test-ciphertext:${btoa(plaintext)}`,
      ),
    decrypt: (ciphertext) => atob(
      new TextDecoder().decode(ciphertext).replace("test-ciphertext:", ""),
    ),
  });
  return { directory, file, store };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Remote Companion encrypted local store", () => {
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
});
