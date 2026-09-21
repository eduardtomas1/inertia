import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { CredentialVault, backendSecretReferenceForProfile } from "../../src/main/credential-vault";

it("keeps persisted credentials after a concurrent cold state read completes", async () => {
  let persisted: string | null = null;
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const vault = new CredentialVault({
    availability: async () => ({ available: true, provider: "keychain", message: null }),
    encrypt: async (secret) => Buffer.from(secret),
    decrypt: async (bytes) => ({ plainText: bytes.toString(), shouldReEncrypt: false }),
  }, {
    read: async () => {
      const snapshot = persisted;
      if (++reads === 1) await gate;
      return snapshot;
    },
    write: async (value) => { persisted = value; },
  });
  const initialState = vault.stateForProfile("first");
  const update = vault.setForProfile("first", "first-credential");
  await setImmediate();
  release();
  await Promise.all([initialState, update]);
  expect(await vault.resolve(backendSecretReferenceForProfile("first"))).toBe("first-credential");
  await vault.setForProfile("second", "second-credential");
  expect(Object.keys(JSON.parse(persisted!).entries)).toHaveLength(2);
});

it("shares a failed cold load and retries on the next request", async () => {
  let reads = 0;
  const vault = new CredentialVault({
    availability: async () => ({ available: true, provider: "keychain", message: null }),
    encrypt: async (secret) => Buffer.from(secret),
    decrypt: async (bytes) => ({ plainText: bytes.toString(), shouldReEncrypt: false }),
  }, {
    read: async () => {
      if (++reads === 1) throw new Error("temporary storage failure");
      return null;
    },
    write: async () => undefined,
  });
  const failed = await Promise.allSettled([
    vault.stateForProfile("first"), vault.stateForProfile("second"),
  ]);
  expect(failed.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  expect(reads).toBe(1);

  await expect(vault.stateForProfile("first")).resolves.toMatchObject({ hasSecret: false });
  expect(reads).toBe(2);
  await vault.setForProfile("first", "saved-after-retry");
  expect(await vault.resolve(backendSecretReferenceForProfile("first"))).toBe("saved-after-retry");
});
