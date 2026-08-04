import { describe, expect, it } from "vitest";

import {
  PrivateConnectStore,
  type PersistedPrivateConnect,
  type PrivateConnectStoreEncryption,
} from "../../../src/main/private-connect/store";

function encryption(available = true): PrivateConnectStoreEncryption {
  return {
    available: () => available,
    encrypt: (value) => new TextEncoder().encode(value),
    decrypt: (value) => new TextDecoder().decode(value),
  };
}

function value(): PersistedPrivateConnect {
  return {
    version: 1,
    enabled: false,
    hostId: "11111111-1111-4111-8111-111111111111",
    servePort: null,
    serveTarget: null,
    grantGeneration: 1,
    pendingAuthorityReduction: null,
    devices: [],
    sessions: [],
    deliveryReceipts: [],
    audit: [],
    migrationNoticeShown: false,
  };
}

describe("Private Connect encrypted store", () => {
  it("round-trips only schema-valid encrypted state", async () => {
    let encoded: string | null = null;
    const persistence = {
      read: async () => encoded,
      write: async (next: string) => { encoded = next; },
    };
    const store = new PrivateConnectStore("/tmp/private-connect-test.vault", encryption(), persistence);
    await store.save(value());
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(await store.load()).toEqual(value());
    encoded = "not base64?";
    await expect(store.load()).rejects.toThrow("encrypted Private Connect store is invalid");
  });

  it("fails closed when secure storage is unavailable or corrupt", async () => {
    const unavailable = new PrivateConnectStore("/tmp/private-connect-test.vault", encryption(false), {
      read: async () => null,
      write: async () => undefined,
    });
    expect(await unavailable.load()).toBeNull();
    await expect(unavailable.save(value())).rejects.toThrow("Secure platform storage is unavailable");

    let encoded = Buffer.from("{\"not\":\"a store\"}").toString("base64");
    const corrupt = new PrivateConnectStore("/tmp/private-connect-test.vault", encryption(), {
      read: async () => encoded,
      write: async (next: string) => { encoded = next; },
    });
    await expect(corrupt.load()).rejects.toThrow("encrypted Private Connect store could not be opened");
  });

  it("appends restart reconciliation, reduction, and delivery fields when reading the prior schema", async () => {
    let encoded = Buffer.from(JSON.stringify({ ...value(), serveTarget: undefined, pendingAuthorityReduction: undefined, deliveryReceipts: undefined }, (_key, current) => current === undefined ? undefined : current)).toString("base64");
    const store = new PrivateConnectStore("/tmp/private-connect-test.vault", encryption(), { read: async () => encoded, write: async (next: string) => { encoded = next; } });
    expect(await store.load()).toMatchObject({ serveTarget: null, pendingAuthorityReduction: null, deliveryReceipts: [] });
  });
});
