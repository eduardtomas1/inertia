import { z } from "zod";

import type { RemoteSerializedKeyPair } from "../../../src/shared/remote-crypto";
import {
  adoptNonExtractableDeviceKeys,
  assertDeviceKeyIsUnexportable,
  assertDeviceKeyPairMatches,
  isNonExtractableDevicePrivateKey,
  UnsupportedDeviceKeyStorage,
} from "./device-keys";
import {
  remoteDesktopCompatibilitySchema,
  remoteScopeSchema,
  type RemoteDesktopCompatibility,
  type RemoteScope,
} from "../../../src/shared/remote-protocol";

export interface BrowserDeviceProfile {
  version: 1;
  deviceId: string;
  deviceLabel: string;
  keyPair: RemoteSerializedKeyPair;
  hostId: string;
  hostPublicKey: string;
  relayUrl: string;
  relayIdentity?: string;
  desktop?: RemoteDesktopCompatibility;
  endpointId: string;
  scopes: RemoteScope[];
  projectIds: string[];
  grantVersion: number;
  expiresAt: string;
}

export interface SealedBrowserDeviceProfile {
  version: 2;
  deviceId: string;
  deviceLabel: string;
  publicKey: string;
  privateKey: CryptoKey;
  hostId: string;
  hostPublicKey: string;
  relayUrl: string;
  relayIdentity?: string;
  desktop?: RemoteDesktopCompatibility;
  endpointId: string;
  scopes: RemoteScope[];
  projectIds: string[];
  grantVersion: number;
  expiresAt: string;
  lastUsedAt: string;
}

export type SealedDeviceProfileLoadResult =
  | { status: "active"; profile: SealedBrowserDeviceProfile }
  | { status: "absent"; profile: null }
  | { status: "expired"; profile: null };

export function profileAuthorizationChanged(
  current: Pick<
    SealedBrowserDeviceProfile,
    "grantVersion" | "scopes" | "projectIds"
  >,
  next: Pick<
    SealedBrowserDeviceProfile,
    "grantVersion" | "scopes" | "projectIds"
  >,
): boolean {
  return next.grantVersion !== current.grantVersion
    || next.scopes.join("\u0000") !== current.scopes.join("\u0000")
    || next.projectIds.join("\u0000") !== current.projectIds.join("\u0000");
}

const DATABASE_NAME = "inertia-remote-companion";
const STORE_NAME = "device";
const PROFILE_KEY = "active";
const SEALED_PROFILE_KEY = "active-sealed";
export const REMOTE_INACTIVITY_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000;
const keyMaterial = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);
const entityId = z.string().min(1).max(200);

export function validateBrowserRelayUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = [
    "127.0.0.1",
    "localhost",
    "[::1]",
  ].includes(url.hostname);
  if (
    url.username
    || url.password
    || url.hash
    || (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback))
  ) {
    throw new Error(
      "Use wss://, or ws:// only for a loopback development relay.",
    );
  }
  return url.toString();
}

export const browserDeviceProfileSchema = z.object({
  version: z.literal(1),
  deviceId: z.string().uuid(),
  deviceLabel: z.string().trim().min(1).max(80),
  keyPair: z.object({
    publicKey: keyMaterial,
    privateKey: keyMaterial,
  }).strict(),
  hostId: z.string().uuid(),
  hostPublicKey: keyMaterial,
  relayUrl: z.string().url().max(2_048).refine(
    (value) => {
      try {
        validateBrowserRelayUrl(value);
        return true;
      } catch {
        return false;
      }
    },
    "Relay URL must use WSS or loopback WS.",
  ),
  relayIdentity: z.string().uuid(),
  desktop: remoteDesktopCompatibilitySchema,
  endpointId: keyMaterial.max(64),
  scopes: z.array(remoteScopeSchema).min(1).max(2),
  projectIds: z.array(entityId).min(1).max(64)
    .refine((value) => new Set(value).size === value.length),
  grantVersion: z.number().int().positive(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const sealedProfileMetadataSchema = browserDeviceProfileSchema
  .omit({ version: true, keyPair: true })
  .extend({
    version: z.literal(2),
    publicKey: keyMaterial,
    lastUsedAt: z.string().datetime({ offset: true }),
  })
  .strict();

function readRecord(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as unknown);
    request.onerror = () => reject(request.error);
  });
}

export function validateSealedProfile(
  raw: unknown,
): SealedBrowserDeviceProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (!isNonExtractableDevicePrivateKey(candidate.privateKey)) return null;
  const { privateKey, ...metadata } = candidate;
  const parsed = sealedProfileMetadataSchema.safeParse(metadata);
  if (!parsed.success) return null;
  return { ...parsed.data, privateKey } as SealedBrowserDeviceProfile;
}

export function sealedProfileHasExpired(
  profile: SealedBrowserDeviceProfile,
  now = Date.now(),
): boolean {
  if (Date.parse(profile.expiresAt) <= now) return true;
  const lastUsed = Date.parse(profile.lastUsedAt);
  if (!Number.isFinite(lastUsed)) return true;
  return now - lastUsed > REMOTE_INACTIVITY_EXPIRY_MS;
}

export async function loadSealedDeviceProfile(): Promise<
  SealedDeviceProfileLoadResult
> {
  const db = await database();
  try {
    const sealedRecord = await readRecord(db, SEALED_PROFILE_KEY);
    const sealed = validateSealedProfile(sealedRecord);
    if (sealed) {
      if (!sealedProfileHasExpired(sealed)) {
        try {
          await assertDeviceKeyIsUnexportable(sealed.privateKey);
          await assertDeviceKeyPairMatches(sealed.publicKey, sealed.privateKey);
        } catch {
          await deleteRecords(db, [SEALED_PROFILE_KEY, PROFILE_KEY]);
          throw new Error(
            "The stored Remote Companion profile was invalid and has been cleared.",
          );
        }
        await deleteRecords(db, [PROFILE_KEY]);
        return { status: "active", profile: sealed };
      }
      await deleteRecords(db, [SEALED_PROFILE_KEY, PROFILE_KEY]);
      return { status: "expired", profile: null };
    }
    if (sealedRecord !== undefined) {
      await deleteRecords(db, [SEALED_PROFILE_KEY, PROFILE_KEY]);
      throw new Error(
        "The stored Remote Companion profile was invalid and has been cleared.",
      );
    }
    const legacy = await readRecord(db, PROFILE_KEY);
    if (legacy === undefined) return { status: "absent", profile: null };
    const parsed = browserDeviceProfileSchema.safeParse(legacy);
    if (!parsed.success) {
      await deleteRecords(db, [PROFILE_KEY, SEALED_PROFILE_KEY]);
      throw new Error(
        "The stored Remote Companion profile was invalid and has been cleared.",
      );
    }
    return await migrateLegacyProfile(db, parsed.data);
  } finally {
    db.close();
  }
}

async function migrateLegacyProfile(
  db: IDBDatabase,
  legacy: BrowserDeviceProfile,
): Promise<SealedDeviceProfileLoadResult> {
  if (Date.parse(legacy.expiresAt) <= Date.now()) {
    await deleteRecords(db, [PROFILE_KEY, SEALED_PROFILE_KEY]);
    return { status: "expired", profile: null };
  }
  let adopted: Awaited<ReturnType<typeof adoptNonExtractableDeviceKeys>>;
  try {
    adopted = await adoptNonExtractableDeviceKeys(
      legacy.keyPair.publicKey,
      legacy.keyPair.privateKey,
    );
  } catch {
    await deleteRecords(db, [PROFILE_KEY, SEALED_PROFILE_KEY]);
    throw new Error(
      "This browser cannot store a Remote Companion identity safely. Pair again.",
    );
  }
  const sealed: SealedBrowserDeviceProfile = {
    version: 2,
    deviceId: legacy.deviceId,
    deviceLabel: legacy.deviceLabel,
    publicKey: adopted.publicKey,
    privateKey: adopted.keyPair.privateKey,
    hostId: legacy.hostId,
    hostPublicKey: legacy.hostPublicKey,
    relayUrl: legacy.relayUrl,
    relayIdentity: legacy.relayIdentity,
    desktop: legacy.desktop,
    endpointId: legacy.endpointId,
    scopes: [...legacy.scopes],
    projectIds: [...legacy.projectIds],
    grantVersion: legacy.grantVersion,
    expiresAt: legacy.expiresAt,
    lastUsedAt: new Date().toISOString(),
  };
  await writeSealedProfile(db, sealed, true);
  return { status: "active", profile: sealed };
}

function writeSealedProfile(
  db: IDBDatabase,
  profile: SealedBrowserDeviceProfile,
  dropLegacy: boolean,
): Promise<void> {
  const { privateKey, ...metadata } = profile;
  const validated = sealedProfileMetadataSchema.parse(metadata);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    try {
      store.put({ ...validated, privateKey }, SEALED_PROFILE_KEY);
    } catch {
      reject(new UnsupportedDeviceKeyStorage(
        "This browser cannot persist a non-extractable device key.",
      ));
      return;
    }
    if (dropLegacy) store.delete(PROFILE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(
      transaction.error ?? new UnsupportedDeviceKeyStorage(
        "This browser rejected the non-extractable device key.",
      ),
    );
  });
}

export async function saveSealedDeviceProfile(
  profile: SealedBrowserDeviceProfile,
): Promise<void> {
  if (!isNonExtractableDevicePrivateKey(profile.privateKey)) {
    throw new UnsupportedDeviceKeyStorage(
      "Refusing to persist an extractable Remote Companion device key.",
    );
  }
  const db = await database();
  try {
    await writeSealedProfile(db, profile, true);
  } finally {
    db.close();
  }
}

export async function touchSealedDeviceProfile(
  profile: SealedBrowserDeviceProfile,
): Promise<SealedBrowserDeviceProfile> {
  const next = { ...profile, lastUsedAt: new Date().toISOString() };
  await saveSealedDeviceProfile(next);
  return next;
}

export async function clearDeviceProfile(): Promise<void> {
  const db = await database();
  try {
    await deleteRecords(db, [PROFILE_KEY, SEALED_PROFILE_KEY]);
  } finally {
    db.close();
  }
}

function deleteRecords(db: IDBDatabase, keys: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const key of keys) store.delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
