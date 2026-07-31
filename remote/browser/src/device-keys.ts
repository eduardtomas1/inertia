import type { RemoteImportedKeyPair } from "../../../src/shared/remote-crypto";

const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;
const PRIVATE_USAGES: readonly KeyUsage[] = ["deriveBits"];

export class UnsupportedDeviceKeyStorage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDeviceKeyStorage";
  }
}

export interface NonExtractableDeviceKeys {
  publicKey: string;
  keyPair: RemoteImportedKeyPair;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Invalid base64url value.");
  }
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function generateNonExtractableDeviceKeys(): Promise<
  NonExtractableDeviceKeys
> {
  const generated = await crypto.subtle.generateKey(
    CURVE,
    false,
    [...PRIVATE_USAGES],
  ) as CryptoKeyPair;
  if (generated.privateKey.extractable) {
    throw new UnsupportedDeviceKeyStorage(
      "This browser produced an extractable device key, so Inertia refuses to "
      + "store a long-lived identity here.",
    );
  }
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", generated.publicKey),
  );
  return {
    publicKey: bytesToBase64Url(raw),
    keyPair: {
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
    },
  };
}

export async function importDevicePublicKey(value: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(value),
    CURVE,
    true,
    [],
  );
}

export async function adoptNonExtractableDeviceKeys(
  serializedPublicKey: string,
  serializedPrivateKey: string,
): Promise<NonExtractableDeviceKeys> {
  const publicBytes = base64UrlToBytes(serializedPublicKey);
  const privateBytes = base64UrlToBytes(serializedPrivateKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) {
    throw new Error("The stored device public key is not an uncompressed P-256 point.");
  }
  if (privateBytes.length !== 32) {
    throw new Error("The stored device private key is not a P-256 scalar.");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: bytesToBase64Url(privateBytes),
      x: bytesToBase64Url(publicBytes.slice(1, 33)),
      y: bytesToBase64Url(publicBytes.slice(33, 65)),
      ext: false,
      key_ops: [...PRIVATE_USAGES],
    },
    CURVE,
    false,
    [...PRIVATE_USAGES],
  );
  if (privateKey.extractable) {
    throw new UnsupportedDeviceKeyStorage(
      "This browser could not make the migrated device key non-extractable.",
    );
  }
  return {
    publicKey: serializedPublicKey,
    keyPair: {
      privateKey,
      publicKey: await importDevicePublicKey(serializedPublicKey),
    },
  };
}

export function isNonExtractableDevicePrivateKey(
  value: unknown,
): value is CryptoKey {
  if (
    typeof CryptoKey === "undefined"
    || !(value instanceof CryptoKey)
    || value.type !== "private"
    || value.extractable
  ) return false;
  const algorithm = value.algorithm;
  return algorithm.name === CURVE.name
    && "namedCurve" in algorithm
    && algorithm.namedCurve === CURVE.namedCurve
    && value.usages.length === PRIVATE_USAGES.length
    && PRIVATE_USAGES.every((usage) => value.usages.includes(usage));
}

export async function assertDeviceKeyIsUnexportable(
  privateKey: CryptoKey,
): Promise<void> {
  try {
    await crypto.subtle.exportKey("jwk", privateKey);
  } catch {
    return;
  }
  throw new UnsupportedDeviceKeyStorage(
    "The stored device key can still be exported, so Inertia refuses to use it.",
  );
}
