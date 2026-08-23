import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CredentialVault,
  CredentialVaultError,
  ElectronSafeStorageBackend,
  FileCredentialVaultPersistence,
  backendSecretReferenceForProfile,
  type CredentialEncryptionBackend,
  type CredentialVaultPersistence,
} from "../../src/main/credential-vault";
import { BACKEND_CREDENTIAL_MASK } from "../../src/shared/backend-credentials";

class MemoryPersistence implements CredentialVaultPersistence {
  value: string | null = null;
  failWrites = false;

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    if (this.failWrites) throw new Error("disk detail that must stay private");
    this.value = value;
  }
}

class TestEncryption implements CredentialEncryptionBackend {
  available = true;
  shouldReEncrypt = false;
  encryptCalls = 0;
  decryptCalls = 0;
  decryptGate: Promise<void> | null = null;

  async availability() {
    return this.available
      ? { available: true as const, provider: "keychain" as const, message: null }
      : {
          available: false as const,
          provider: "unavailable" as const,
          message: "Secure credential storage is unavailable on this system.",
        };
  }

  async encrypt(plainText: string): Promise<Buffer> {
    this.encryptCalls += 1;
    return Buffer.from(`protected:${plainText}`, "utf8");
  }

  async decrypt(encrypted: Buffer) {
    this.decryptCalls += 1;
    await this.decryptGate;
    const value = encrypted.toString("utf8");
    if (!value.startsWith("protected:")) throw new Error("bad key");
    return {
      plainText: value.slice("protected:".length),
      shouldReEncrypt: this.shouldReEncrypt,
    };
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("CredentialVault", () => {
  it("persists only encrypted material and exposes masked presence state", async () => {
    const persistence = new MemoryPersistence();
    const encryption = new TestEncryption();
    const vault = new CredentialVault(encryption, persistence);
    const state = await vault.setForProfile("kimi", "top-secret-value");

    expect(state).toEqual({
      profileId: "kimi",
      hasSecret: true,
      maskedValue: BACKEND_CREDENTIAL_MASK,
      credentialGeneration: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      storage: { available: true, provider: "keychain", message: null },
    });
    expect(persistence.value).not.toContain("top-secret-value");
    expect(persistence.value).not.toContain(BACKEND_CREDENTIAL_MASK);

    const reopened = new CredentialVault(encryption, persistence);
    expect(await reopened.resolve(backendSecretReferenceForProfile("kimi")))
      .toBe("top-secret-value");
  });

  it("rejects masked placeholders without overwriting the saved credential", async () => {
    const persistence = new MemoryPersistence();
    const encryption = new TestEncryption();
    const vault = new CredentialVault(encryption, persistence);
    const reference = backendSecretReferenceForProfile("custom");
    await vault.setForProfile("custom", "original-secret");

    await expect(vault.setForProfile("custom", BACKEND_CREDENTIAL_MASK))
      .rejects.toMatchObject({ code: "invalid-input" });
    expect(await vault.resolve(reference)).toBe("original-secret");
  });

  it("fails closed when OS protection is unavailable while still allowing deletion", async () => {
    const persistence = new MemoryPersistence();
    const encryption = new TestEncryption();
    const vault = new CredentialVault(encryption, persistence);
    const reference = backendSecretReferenceForProfile("custom");
    await vault.setForProfile("custom", "secret");
    encryption.available = false;

    await expect(vault.resolve(reference)).rejects.toMatchObject({
      code: "storage-unavailable",
    });
    await expect(vault.setForProfile("custom", "replacement")).rejects.toMatchObject({
      code: "storage-unavailable",
    });
    expect(await vault.clear(reference)).toBe(true);
    expect(await vault.has(reference)).toBe(false);
  });

  it("rolls back cached state when persistence fails", async () => {
    const persistence = new MemoryPersistence();
    const encryption = new TestEncryption();
    const vault = new CredentialVault(encryption, persistence);
    await vault.setForProfile("custom", "original");
    persistence.failWrites = true;

    await expect(vault.setForProfile("custom", "replacement")).rejects.toMatchObject({
      code: "persistence-failed",
    });
    persistence.failWrites = false;
    expect(await vault.resolve(backendSecretReferenceForProfile("custom"))).toBe("original");
  });

  it("re-encrypts ciphertext when the platform reports key rotation", async () => {
    const persistence = new MemoryPersistence();
    const encryption = new TestEncryption();
    const vault = new CredentialVault(encryption, persistence);
    await vault.setForProfile("custom", "rotating-secret");
    encryption.shouldReEncrypt = true;

    expect(await vault.resolve(backendSecretReferenceForProfile("custom")))
      .toBe("rotating-secret");
    expect(encryption.encryptCalls).toBe(2);
  });

  it("preserves credential generation across platform ciphertext rotation", async () => {
    const persistence = new MemoryPersistence();
    const encryption = new TestEncryption();
    const vault = new CredentialVault(encryption, persistence);
    const before = await vault.setForProfile("custom", "rotating-secret");
    encryption.shouldReEncrypt = true;

    await vault.resolve(backendSecretReferenceForProfile("custom"));
    const after = await vault.stateForProfile("custom");
    expect(after.credentialGeneration).toBe(before.credentialGeneration);
  });

  it("persists set and clear generations across crash-window reopen", async () => {
    const persistence = new MemoryPersistence();
    const encryption = new TestEncryption();
    const vault = new CredentialVault(encryption, persistence);
    const setState = await vault.setForProfile("custom", "secret");

    const afterSetCrash = new CredentialVault(encryption, persistence);
    expect((await afterSetCrash.stateForProfile("custom")).credentialGeneration)
      .toBe(setState.credentialGeneration);
    const clearState = await afterSetCrash.clearForProfile("custom");
    expect(clearState).toMatchObject({
      hasSecret: false,
      maskedValue: null,
      credentialGeneration: expect.any(String),
    });
    expect(clearState.credentialGeneration).not.toBe(setState.credentialGeneration);

    const afterClearCrash = new CredentialVault(encryption, persistence);
    expect(await afterClearCrash.stateForProfile("custom")).toMatchObject({
      hasSecret: false,
      credentialGeneration: clearState.credentialGeneration,
    });
    expect(await afterClearCrash.resolve(backendSecretReferenceForProfile("custom")))
      .toBeNull();
  });

  it("migrates v1 entries to a stable non-secret generation", async () => {
    const profileId = "legacy";
    const reference = backendSecretReferenceForProfile(profileId);
    const persistence = new MemoryPersistence();
    persistence.value = JSON.stringify({
      schemaVersion: 1,
      entries: {
        [reference]: {
          ciphertext: Buffer.from("protected:legacy-secret").toString("base64"),
          updatedAt: "2026-07-24T12:00:00.000Z",
        },
      },
    });
    const encryption = new TestEncryption();
    const first = new CredentialVault(encryption, persistence);
    const firstState = await first.stateForProfile(profileId);
    const reopened = new CredentialVault(encryption, persistence);
    expect((await reopened.stateForProfile(profileId)).credentialGeneration)
      .toBe(firstState.credentialGeneration);
    expect(firstState.credentialGeneration).toMatch(/^legacy:[0-9a-f]{64}$/u);
    expect(await reopened.resolve(reference)).toBe("legacy-secret");

    await reopened.setForProfile(profileId, "replacement");
    expect(JSON.parse(persistence.value ?? "{}")).toMatchObject({
      schemaVersion: 2,
      entries: {
        [reference]: {
          credentialGeneration: expect.not.stringMatching(/^legacy:/u),
        },
      },
    });
  });

  it("forgets deleted-profile tombstones without evicting live credentials", async () => {
    const persistence = new MemoryPersistence();
    const encryption = new TestEncryption();
    const vault = new CredentialVault(encryption, persistence);
    const live = await vault.setForProfile("live-profile", "live-secret");

    for (let index = 0; index < 300; index += 1) {
      const profileId = `deleted-profile-${index}`;
      await vault.clearForProfile(profileId);
      expect(await vault.forgetForProfile(profileId)).toBe(true);
    }

    expect(await vault.resolve(backendSecretReferenceForProfile("live-profile")))
      .toBe("live-secret");
    expect((await vault.stateForProfile("live-profile")).credentialGeneration)
      .toBe(live.credentialGeneration);
    const persisted = JSON.parse(persistence.value ?? "{}") as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(persisted.entries)).toEqual([
      backendSecretReferenceForProfile("live-profile"),
    ]);
  });

  it("does not restore an older secret during concurrent key rotation", async () => {
    const persistence = new MemoryPersistence();
    const encryption = new TestEncryption();
    const vault = new CredentialVault(encryption, persistence);
    const reference = backendSecretReferenceForProfile("custom");
    await vault.setForProfile("custom", "old-secret");
    encryption.shouldReEncrypt = true;
    let releaseDecrypt!: () => void;
    encryption.decryptGate = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });

    const resolvingOldSecret = vault.resolve(reference);
    await vi.waitFor(() => expect(encryption.decryptCalls).toBe(1));
    await vault.setForProfile("custom", "new-secret");
    releaseDecrypt();
    expect(await resolvingOldSecret).toBe("old-secret");

    encryption.decryptGate = null;
    encryption.shouldReEncrypt = false;
    expect(await vault.resolve(reference)).toBe("new-secret");
  });

  it("returns fixed public errors for corrupt vaults and decryption failures", async () => {
    const persistence = new MemoryPersistence();
    persistence.value = '{"schemaVersion":1,"entries":{"secret:bad":{"ciphertext":"plaintext","updatedAt":"nope"}}}';
    const vault = new CredentialVault(new TestEncryption(), persistence);

    await expect(vault.stateForProfile("custom")).rejects.toEqual(
      new CredentialVaultError("storage-corrupt", "The secure credential vault is invalid."),
    );
  });
});

describe("ElectronSafeStorageBackend", () => {
  function safeStorageStub(options: {
    backend?: string;
    available?: boolean;
  } = {}) {
    return {
      getSelectedStorageBackend: vi.fn(() => options.backend ?? "gnome_libsecret"),
      isAsyncEncryptionAvailable: vi.fn(async () => options.available ?? true),
      encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value)),
      decryptStringAsync: vi.fn(async (value: Buffer) => ({
        result: value.toString("utf8"),
        shouldReEncrypt: false,
      })),
    };
  }

  it("maps protected platform stores and rejects Linux plaintext fallback", async () => {
    expect(await new ElectronSafeStorageBackend(safeStorageStub() as never, "darwin").availability())
      .toMatchObject({ available: true, provider: "keychain" });
    expect(await new ElectronSafeStorageBackend(safeStorageStub() as never, "win32").availability())
      .toMatchObject({ available: true, provider: "dpapi" });
    expect(await new ElectronSafeStorageBackend(
      safeStorageStub({ backend: "gnome_libsecret" }) as never,
      "linux",
    ).availability()).toMatchObject({ available: true, provider: "secret-service" });
    expect(await new ElectronSafeStorageBackend(
      safeStorageStub({ backend: "basic_text" }) as never,
      "linux",
    ).availability()).toMatchObject({ available: false, provider: "unavailable" });
    expect(await new ElectronSafeStorageBackend(
      safeStorageStub({ backend: "unknown" }) as never,
      "linux",
    ).availability()).toMatchObject({ available: false, provider: "unavailable" });
  });

  it("fails closed when asynchronous encryption is unavailable", async () => {
    const state = await new ElectronSafeStorageBackend(
      safeStorageStub({ available: false }) as never,
      "darwin",
    ).availability();
    expect(state).toEqual({
      available: false,
      provider: "unavailable",
      message: "Secure credential storage is unavailable on this system.",
    });
  });
});

describe("FileCredentialVaultPersistence", () => {
  it("atomically writes a restrictive bounded vault file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-credential-vault-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "credentials.json");
    const persistence = new FileCredentialVaultPersistence(path);
    const staleTemporaryPath = join(directory, "nested", ".credential-vault-stale.tmp");
    await mkdir(join(directory, "nested"));
    await writeFile(staleTemporaryPath, "stale", { encoding: "utf8" });
    await persistence.write('{"schemaVersion":1,"entries":{}}');

    expect(await persistence.read()).toBe('{"schemaVersion":1,"entries":{}}');
    await expect(stat(staleTemporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path, "utf8")).not.toContain("secret-value");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("removes only the owned regular vault file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-credential-vault-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "credentials.json");
    const persistence = new FileCredentialVaultPersistence(path);
    await persistence.write("owned-value");

    await persistence.remove();

    expect(await persistence.read()).toBeNull();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(persistence.remove()).resolves.toBeUndefined();
  });

  it("reads until complete when the filesystem returns short reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-credential-vault-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "credentials.json");
    const expected = '{"schemaVersion":2,"entries":{"opaque":"ciphertext"}}';
    await writeFile(path, expected, { encoding: "utf8", mode: 0o600 });
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ): Promise<{ bytesRead: number; buffer: Buffer }>;
    };
    await probe.close();
    const originalRead = prototype.read;
    const read = vi.spyOn(prototype, "read").mockImplementation(function (
      this: typeof prototype,
      buffer,
      offset,
      length,
      position,
    ) {
      return originalRead.call(
        this,
        buffer,
        offset,
        Math.min(length, 3),
        position,
      );
    });
    try {
      await expect(new FileCredentialVaultPersistence(path).read())
        .resolves.toBe(expected);
      expect(read.mock.calls.length).toBeGreaterThan(1);
    } finally {
      read.mockRestore();
    }
  });

  it("rejects content that changes through the opened vault identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-credential-vault-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "credentials.json");
    const expected = '{"schemaVersion":2,"entries":{}}';
    await writeFile(path, expected, { encoding: "utf8", mode: 0o600 });
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ): Promise<{ bytesRead: number; buffer: Buffer }>;
    };
    await probe.close();
    const originalRead = prototype.read;
    let changed = false;
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: typeof prototype,
      buffer,
      offset,
      length,
      position,
    ) {
      const result = await originalRead.call(
        this,
        buffer,
        offset,
        Math.min(length, 4),
        position,
      );
      if (!changed) {
        changed = true;
        await writeFile(path, "x".repeat(Buffer.byteLength(expected)), {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      return result;
    });
    try {
      await expect(new FileCredentialVaultPersistence(path).read())
        .rejects.toMatchObject({ code: "storage-corrupt" });
    } finally {
      read.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "refuses to read or replace a symlinked vault target",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inertia-credential-vault-"));
      temporaryDirectories.push(directory);
      const protectedDirectory = join(directory, "protected");
      const outsidePath = join(directory, "outside.json");
      const vaultPath = join(protectedDirectory, "credentials.json");
      await mkdir(protectedDirectory);
      await writeFile(outsidePath, "outside-value", { encoding: "utf8" });
      await symlink(outsidePath, vaultPath);
      const persistence = new FileCredentialVaultPersistence(vaultPath);

      await expect(persistence.read()).rejects.toMatchObject({
        code: "storage-corrupt",
      });
      await expect(persistence.write("replacement")).rejects.toMatchObject({
        code: "persistence-failed",
      });
      await expect(persistence.remove()).rejects.toMatchObject({
        code: "persistence-failed",
      });
      expect(await readFile(outsidePath, "utf8")).toBe("outside-value");
    },
  );
});
