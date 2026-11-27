import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CredentialVault,
  CredentialVaultError,
  ElectronSafeStorageBackend,
  FileCredentialVaultPersistence,
  MAX_CREDENTIAL_VAULT_BYTES,
  type CredentialEncryptionBackend,
  type CredentialVaultPersistence,
} from "../../src/main/credential-vault";
import { runtimeCredentialBroker } from "../../src/main/runtime-credential-broker";
import { agentSecretReference } from "../../src/node/agent-secrets";

const SECRET = "fake-token-kQ7xZ9pL2mN4";

class MemoryPersistence implements CredentialVaultPersistence {
  value: string | null = null;
  failWrites = false;
  async read(): Promise<string | null> { return this.value; }
  async write(value: string): Promise<void> {
    if (this.failWrites) throw new Error("disk detail");
    this.value = value;
  }
}

class TestEncryption implements CredentialEncryptionBackend {
  available = true;
  async availability() {
    return this.available
      ? { available: true as const, provider: "keychain" as const, message: null }
      : { available: false as const, provider: "unavailable" as const, message: "Secure credential storage is unavailable on this system." };
  }
  async encrypt(plainText: string): Promise<Buffer> { return Buffer.from(`protected:${plainText}`, "utf8"); }
  async decrypt(encrypted: Buffer) {
    return { plainText: encrypted.toString("utf8").slice("protected:".length), shouldReEncrypt: false };
  }
}

function vault() {
  const encryption = new TestEncryption();
  const persistence = new MemoryPersistence();
  return { encryption, persistence, vault: new CredentialVault(encryption, persistence) };
}

async function invalidInput(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CredentialVaultError);
  expect((error as CredentialVaultError).code).toBe("invalid-input");
  expect((error as Error).message).not.toContain(SECRET);
}

describe("CredentialVault agent secrets", () => {
  it("stores under the agent secret reference and resolves through the runtime broker", async () => {
    const { vault: store, persistence } = vault();
    const requestId = randomUUID();
    await expect(store.setAgentSecret(requestId, SECRET)).resolves.toBe("stored");
    expect(Object.keys(JSON.parse(persistence.value ?? "{}").entries)).toEqual([`secret:agent-secret:${requestId}`]);
    expect(persistence.value).not.toContain(SECRET);
    const broker = runtimeCredentialBroker(() => store);
    await expect(broker.resolve(agentSecretReference(requestId))).resolves.toBe(SECRET);
  });

  it("never overwrites an existing entry", async () => {
    const { vault: store } = vault();
    const requestId = randomUUID();
    await store.setAgentSecret(requestId, SECRET);
    await expect(store.setAgentSecret(requestId, "replacement-secret")).resolves.toBe("exists");
    await expect(store.resolve(agentSecretReference(requestId))).resolves.toBe(SECRET);
  });

  it("reports unavailable storage instead of failing", async () => {
    const { vault: store, encryption, persistence } = vault();
    encryption.available = false;
    await expect(store.setAgentSecret(randomUUID(), SECRET)).resolves.toBe("unavailable");
    expect(persistence.value).toBeNull();
  });

  it("propagates persistence failures without the value", async () => {
    const { vault: store, persistence } = vault();
    persistence.failWrites = true;
    const error = await store.setAgentSecret(randomUUID(), SECRET).then(() => null, (caught: unknown) => caught);
    expect((error as CredentialVaultError).code).toBe("persistence-failed");
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("rejects invalid request ids and values", async () => {
    const { vault: store } = vault();
    await invalidInput(store.setAgentSecret("request-1", SECRET));
    await invalidInput(store.setAgentSecret(randomUUID(), "abc"));
    await invalidInput(store.setAgentSecret(randomUUID(), ` ${SECRET}`));
    await invalidInput(store.setAgentSecret(randomUUID(), "line\nbreak"));
    await invalidInput(store.deleteAgentSecret("../backend"));
  });

  it("deletes through the namespace and through the runtime broker forget path", async () => {
    const { vault: store } = vault();
    const direct = randomUUID();
    const brokered = randomUUID();
    await store.setAgentSecret(direct, SECRET);
    await store.setAgentSecret(brokered, SECRET);
    await expect(store.deleteAgentSecret(direct)).resolves.toBe(true);
    await expect(store.deleteAgentSecret(direct)).resolves.toBe(false);
    await expect(runtimeCredentialBroker(() => store).forget(agentSecretReference(brokered))).resolves.toBe(true);
    await expect(store.status(agentSecretReference(direct))).resolves.toEqual({ hasSecret: false, credentialGeneration: null });
    await expect(store.status(agentSecretReference(brokered))).resolves.toEqual({ hasSecret: false, credentialGeneration: null });
    await expect(store.setAgentSecret(direct, SECRET)).resolves.toBe("stored");
  });

  it("enumerates only agent secret request ids for the runtime broker, never values or backend credentials", async () => {
    const { vault: store, persistence } = vault();
    const requestId = randomUUID();
    await store.setForProfile("profile-1", "backend-credential-value");
    await store.setAgentSecret(requestId, SECRET);
    await store.resolveOrCreate("secret:agent-secret:not-a-request");
    const broker = runtimeCredentialBroker(() => store).agentSecrets!;
    const ids = await broker.requestIds();
    expect(ids).toEqual([requestId]);
    expect(JSON.stringify(ids)).not.toContain(SECRET);
    await expect(broker.forget(requestId)).resolves.toBe(true);
    await expect(broker.requestIds()).resolves.toEqual([]);
    await expect(store.stateForProfile("profile-1")).resolves.toMatchObject({ hasSecret: true });
    await expect(store.has("secret:agent-secret:not-a-request")).resolves.toBe(true);
    expect(persistence.value).not.toContain(SECRET);
    await invalidInput(broker.forget("secret:backend:profile-1"));
  });

  it("supports 2 MiB vault capacity so 32 max-size agent secrets coexist with backend credentials", async () => {
    expect(MAX_CREDENTIAL_VAULT_BYTES).toBe(2 * 1_048_576);
    const { vault: store, persistence } = vault();
    for (let i = 0; i < 4; i += 1) {
      await store.setForProfile(`profile-${i}`, `backend-secret-${"b".repeat(1_024)}-${i}`);
    }
    const maxSecret = "s".repeat(16_384);
    for (let i = 0; i < 32; i += 1) {
      await expect(store.setAgentSecret(randomUUID(), maxSecret)).resolves.toBe("stored");
    }
    expect(Buffer.byteLength(persistence.value ?? "", "utf8")).toBeLessThanOrEqual(MAX_CREDENTIAL_VAULT_BYTES);
  });
});

describe("ElectronSafeStorageBackend Linux async ordering", () => {
  it("awaits isAsyncEncryptionAvailable before reading getSelectedStorageBackend on Linux", async () => {
    const callOrder: string[] = [];
    let selectedBackend = "unknown";
    const storage = {
      isAsyncEncryptionAvailable: vi.fn(async () => {
        callOrder.push("isAsyncEncryptionAvailable");
        await Promise.resolve();
        selectedBackend = "gnome_libsecret";
        return true;
      }),
      getSelectedStorageBackend: vi.fn(() => {
        callOrder.push("getSelectedStorageBackend");
        return selectedBackend;
      }),
      encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value)),
      decryptStringAsync: vi.fn(async (value: Buffer) => ({ result: value.toString("utf8"), shouldReEncrypt: false })),
    };

    const backend = new ElectronSafeStorageBackend(storage as never, "linux");
    await expect(backend.availability()).resolves.toEqual({
      available: true,
      provider: "secret-service",
      message: null,
    });
    expect(callOrder).toEqual(["isAsyncEncryptionAvailable", "getSelectedStorageBackend"]);
  });
});

describe("FileCredentialVaultPersistence Windows rename retries", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  function errno(code: string): NodeJS.ErrnoException {
    const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  }

  it("retries transient EPERM, EBUSY, and EACCES rename failures on win32 and succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-vault-win32-retry-"));
    directories.push(directory);
    const path = join(directory, "credentials.json");
    const sleeps: number[] = [];
    const transientErrors = ["EPERM", "EBUSY", "EACCES"];
    let renameCalls = 0;
    const persistence = new FileCredentialVaultPersistence(path, {
      platform: "win32",
      sleep: async (ms) => { sleeps.push(ms); },
      renameFile: async (from, to) => {
        renameCalls += 1;
        if (renameCalls <= transientErrors.length) {
          throw errno(transientErrors[renameCalls - 1]!);
        }
        await rename(from, to);
      },
    });

    await persistence.write('{"schemaVersion":2,"entries":{}}');
    expect(renameCalls).toBe(4);
    expect(sleeps).toEqual([25, 50, 75]);
    expect(await persistence.read()).toBe('{"schemaVersion":2,"entries":{}}');
  });

  it("restores the previous vault after 5 failed win32 rename attempts and never retries non-win32", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "inertia-vault-win32-exhaust-")));
    directories.push(directory);
    const path = join(directory, "credentials.json");
    const initial = '{"schemaVersion":2,"entries":{}}';
    await new FileCredentialVaultPersistence(path).write(initial);

    let win32Attempts = 0;
    const win32Sleeps: number[] = [];
    const win32Persistence = new FileCredentialVaultPersistence(path, {
      platform: "win32",
      sleep: async (ms) => { win32Sleeps.push(ms); },
      renameFile: async (from, to) => {
        if (to === path && from.endsWith(".stage")) {
          win32Attempts += 1;
          throw errno("EBUSY");
        }
        await rename(from, to);
      },
    });

    await expect(win32Persistence.write('{"schemaVersion":2,"entries":{"k":"v"}}'))
      .rejects.toMatchObject({ code: "persistence-failed" });
    expect(win32Attempts).toBe(5);
    expect(win32Sleeps).toEqual([25, 50, 75, 100]);
    expect(await new FileCredentialVaultPersistence(path).read()).toBe(initial);

    let linuxAttempts = 0;
    const linuxPersistence = new FileCredentialVaultPersistence(path, {
      platform: "linux",
      sleep: async () => undefined,
      renameFile: async () => {
        linuxAttempts += 1;
        throw errno("EBUSY");
      },
    });
    await expect(linuxPersistence.write('{"schemaVersion":2,"entries":{}}'))
      .rejects.toMatchObject({ code: "persistence-failed" });
    expect(linuxAttempts).toBe(1);
  });

  it("preserves the backup file on win32 when both stage install and rollback fail so recovery restores the vault", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "inertia-vault-win32-backup-keep-")));
    directories.push(directory);
    const path = join(directory, "credentials.json");
    const initial = '{"schemaVersion":2,"entries":{"existing":"kept"}}';
    await new FileCredentialVaultPersistence(path).write(initial);

    let backupMoved = false;
    const failingPersistence = new FileCredentialVaultPersistence(path, {
      platform: "win32",
      sleep: async () => undefined,
      renameFile: async (from, to) => {
        if (from === path && to.endsWith(".backup")) {
          backupMoved = true;
          await rename(from, to);
          return;
        }
        throw errno("EPERM");
      },
    });

    await expect(failingPersistence.write('{"schemaVersion":2,"entries":{"next":"value"}}'))
      .rejects.toMatchObject({ code: "persistence-failed" });
    expect(backupMoved).toBe(true);
    expect(await new FileCredentialVaultPersistence(path).read()).toBe(initial);
  });
});

