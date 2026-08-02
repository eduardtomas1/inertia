import { describe, expect, it } from "vitest";

import {
  adoptNonExtractableDeviceKeys,
  assertDeviceKeyIsUnexportable,
  assertDeviceKeyPairMatches,
  generateNonExtractableDeviceKeys,
  importDevicePublicKey,
  isNonExtractableDevicePrivateKey,
  UnsupportedDeviceKeyStorage,
} from "../remote/browser/src/device-keys";
import {
  REMOTE_INACTIVITY_EXPIRY_MS,
  sealedProfileHasExpired,
  validateSealedProfile,
  type SealedBrowserDeviceProfile,
} from "../remote/browser/src/device-store";
import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  generateRemoteKeyPair,
  importRemoteKeyPair,
  openSessionData,
  sealSessionData,
} from "../src/shared/remote-crypto";
import { REMOTE_DESKTOP_COMPATIBILITY } from "../src/shared/remote-protocol";

const HOST_ID = "5f7b2c1e-2a44-4a1f-9d4a-8c6f0d5b1a11";
const DEVICE_ID = "09400fa3-32c0-4d8d-8d17-e8ea0a4f6937";
const SESSION_ID = "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e";

async function sealedProfile(
  overrides: Partial<SealedBrowserDeviceProfile> = {},
): Promise<SealedBrowserDeviceProfile> {
  const keys = await generateNonExtractableDeviceKeys();
  const host = await generateRemoteKeyPair();
  return {
    version: 2,
    deviceId: DEVICE_ID,
    deviceLabel: "Test browser",
    publicKey: keys.publicKey,
    privateKey: keys.keyPair.privateKey,
    hostId: HOST_ID,
    hostPublicKey: host.publicKey,
    relayUrl: "wss://relay.example/remote",
    relayIdentity: "a669bb38-857d-4b8d-a0aa-3a592197d2c8",
    desktop: REMOTE_DESKTOP_COMPATIBILITY,
    endpointId: "opaque_endpoint",
    scopes: ["view"],
    projectIds: ["project"],
    grantVersion: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lastUsedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("non-extractable browser device keys", () => {
  it("creates a private key that cannot be exported", async () => {
    const keys = await generateNonExtractableDeviceKeys();
    expect(keys.keyPair.privateKey.extractable).toBe(false);
    expect(keys.keyPair.privateKey.type).toBe("private");
    await expect(crypto.subtle.exportKey("jwk", keys.keyPair.privateKey))
      .rejects.toThrow();
    await expect(crypto.subtle.exportKey("pkcs8", keys.keyPair.privateKey))
      .rejects.toThrow();
    await expect(assertDeviceKeyIsUnexportable(keys.keyPair.privateKey))
      .resolves.toBeUndefined();
  });

  it("keeps only the public key in serializable form", async () => {
    const keys = await generateNonExtractableDeviceKeys();
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/u);
    const imported = await importDevicePublicKey(keys.publicKey);
    expect(imported.type).toBe("public");
    expect(imported.extractable).toBe(true);
  });

  it("still completes an authenticated HPKE session", async () => {
    const device = await generateNonExtractableDeviceKeys();
    const host = await importRemoteKeyPair(await generateRemoteKeyPair());
    const sender = await createAuthenticatedSessionSender(
      HOST_ID,
      DEVICE_ID,
      SESSION_ID,
      host,
      device.keyPair.publicKey,
    );
    const recipient = await createAuthenticatedSessionRecipient(
      HOST_ID,
      DEVICE_ID,
      SESSION_ID,
      device.keyPair,
      host.publicKey,
      sender.enc,
    );
    const frame = await sealSessionData(sender, SESSION_ID, { ok: true });
    expect(await openSessionData(recipient, frame)).toEqual({ ok: true });
  });

  it("verifies that the stored public and private keys belong together", async () => {
    const stored = await generateNonExtractableDeviceKeys();
    await expect(assertDeviceKeyPairMatches(
      stored.publicKey,
      stored.keyPair.privateKey,
    )).resolves.toBeUndefined();

    const other = await generateNonExtractableDeviceKeys();
    await expect(assertDeviceKeyPairMatches(
      other.publicKey,
      stored.keyPair.privateKey,
    )).rejects.toThrow("public and private keys do not match");
    await expect(assertDeviceKeyPairMatches(
      "not-a-p256-point",
      stored.keyPair.privateKey,
    )).rejects.toThrow("public and private keys do not match");
  });

  it("rejects an extractable private key as a stored identity", async () => {
    const extractable = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    ) as CryptoKeyPair;
    expect(isNonExtractableDevicePrivateKey(extractable.privateKey)).toBe(false);
    await expect(assertDeviceKeyIsUnexportable(extractable.privateKey))
      .rejects.toBeInstanceOf(UnsupportedDeviceKeyStorage);
  });

  it("rejects a non-extractable private key for another algorithm", async () => {
    const rsa = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2_048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      false,
      ["decrypt"],
    ) as CryptoKeyPair;
    expect(rsa.privateKey.extractable).toBe(false);
    expect(isNonExtractableDevicePrivateKey(rsa.privateKey)).toBe(false);
    const profile = await sealedProfile();
    const { privateKey: _ignored, ...metadata } = profile;
    expect(validateSealedProfile({
      ...metadata,
      privateKey: rsa.privateKey,
    })).toBeNull();
  });

  it("rejects non-CryptoKey values as a stored identity", () => {
    for (const value of [null, undefined, "key", 1, {}, []]) {
      expect(isNonExtractableDevicePrivateKey(value)).toBe(false);
    }
  });
});

describe("migration from the extractable storage model", () => {
  it("preserves the device identity without re-pairing", async () => {
    const legacy = await generateRemoteKeyPair();
    const adopted = await adoptNonExtractableDeviceKeys(
      legacy.publicKey,
      legacy.privateKey,
    );
    expect(adopted.publicKey).toBe(legacy.publicKey);
    expect(adopted.keyPair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", adopted.keyPair.privateKey))
      .rejects.toThrow();

    const host = await importRemoteKeyPair(await generateRemoteKeyPair());
    const sender = await createAuthenticatedSessionSender(
      HOST_ID,
      DEVICE_ID,
      SESSION_ID,
      host,
      adopted.keyPair.publicKey,
    );
    const recipient = await createAuthenticatedSessionRecipient(
      HOST_ID,
      DEVICE_ID,
      SESSION_ID,
      adopted.keyPair,
      host.publicKey,
      sender.enc,
    );
    const frame = await sealSessionData(sender, SESSION_ID, { migrated: true });
    expect(await openSessionData(recipient, frame)).toEqual({ migrated: true });
  });

  it("refuses malformed legacy key material", async () => {
    const legacy = await generateRemoteKeyPair();
    await expect(adoptNonExtractableDeviceKeys("AAAA", legacy.privateKey))
      .rejects.toThrow("uncompressed P-256 point");
    await expect(adoptNonExtractableDeviceKeys(legacy.publicKey, "AAAA"))
      .rejects.toThrow("P-256 scalar");
    await expect(adoptNonExtractableDeviceKeys("not base64url!", "AAAA"))
      .rejects.toThrow();
  });

  it("never yields exportable material after migration", async () => {
    const legacy = await generateRemoteKeyPair();
    const adopted = await adoptNonExtractableDeviceKeys(
      legacy.publicKey,
      legacy.privateKey,
    );
    for (const format of ["jwk", "pkcs8", "raw"] as const) {
      await expect(
        crypto.subtle.exportKey(format, adopted.keyPair.privateKey),
      ).rejects.toThrow();
    }
  });
});

describe("sealed profile validation", () => {
  it("accepts a well-formed sealed profile", async () => {
    const profile = await sealedProfile();
    const { privateKey, ...metadata } = profile;
    expect(validateSealedProfile({ ...metadata, privateKey })).toMatchObject({
      version: 2,
      deviceId: DEVICE_ID,
    });
  });

  it("rejects a sealed profile whose key is extractable", async () => {
    const profile = await sealedProfile();
    const extractable = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    ) as CryptoKeyPair;
    const { privateKey: _ignored, ...metadata } = profile;
    expect(validateSealedProfile({
      ...metadata,
      privateKey: extractable.privateKey,
    })).toBeNull();
  });

  it("rejects a sealed profile that kept serialized private material", async () => {
    const profile = await sealedProfile();
    const { privateKey, ...metadata } = profile;
    expect(validateSealedProfile({
      ...metadata,
      privateKey,
      keyPair: { publicKey: "aaa", privateKey: "bbb" },
    })).toBeNull();
  });

  it("rejects a sealed profile with an unsafe relay URL", async () => {
    const profile = await sealedProfile({ relayUrl: "ws://relay.example/x" });
    const { privateKey, ...metadata } = profile;
    expect(validateSealedProfile({ ...metadata, privateKey })).toBeNull();
  });

  it("rejects an interrupted migration that left no key", async () => {
    const profile = await sealedProfile();
    const { privateKey: _dropped, ...metadata } = profile;
    expect(validateSealedProfile(metadata)).toBeNull();
    expect(validateSealedProfile(null)).toBeNull();
    expect(validateSealedProfile("sealed")).toBeNull();
  });
});

describe("grant and inactivity expiry", () => {
  it("expires on the grant deadline", async () => {
    const profile = await sealedProfile({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(sealedProfileHasExpired(profile)).toBe(true);
  });

  it("expires after the inactivity window", async () => {
    const now = Date.now();
    const profile = await sealedProfile({
      expiresAt: new Date(now + 90 * 24 * 60 * 60 * 1_000).toISOString(),
      lastUsedAt: new Date(now - REMOTE_INACTIVITY_EXPIRY_MS - 1_000)
        .toISOString(),
    });
    expect(sealedProfileHasExpired(profile, now)).toBe(true);
  });

  it("stays valid inside both windows", async () => {
    const now = Date.now();
    const profile = await sealedProfile({
      expiresAt: new Date(now + 60_000).toISOString(),
      lastUsedAt: new Date(now - 1_000).toISOString(),
    });
    expect(sealedProfileHasExpired(profile, now)).toBe(false);
  });

  it("treats a missing or malformed last-used stamp as expired", async () => {
    const profile = await sealedProfile();
    expect(sealedProfileHasExpired({
      ...profile,
      lastUsedAt: "not-a-date",
    })).toBe(true);
  });

  it("keeps the inactivity window shorter than the maximum grant", () => {
    expect(REMOTE_INACTIVITY_EXPIRY_MS).toBeLessThan(
      90 * 24 * 60 * 60 * 1_000,
    );
    expect(REMOTE_INACTIVITY_EXPIRY_MS).toBeGreaterThan(24 * 60 * 60 * 1_000);
  });
});
