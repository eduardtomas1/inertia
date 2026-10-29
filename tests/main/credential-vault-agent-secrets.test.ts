import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CredentialVault,
  CredentialVaultError,
  type CredentialEncryptionBackend,
  type CredentialVaultPersistence,
} from "../../src/main/credential-vault";
import { runtimeCredentialBroker } from "../../src/main/runtime-credential-broker";
import { agentSecretReference } from "../../src/shared/agent-secrets";

const SECRET = "tskey-auth-kQ7xZ9pL2mN4";

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
});
