import { z } from "zod";

import type { RemoteSerializedKeyPair } from "../../../src/shared/remote-crypto";
import {
  remoteScopeSchema,
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
  endpointId: string;
  scopes: RemoteScope[];
  projectIds: string[];
  grantVersion: number;
  expiresAt: string;
}

const DATABASE_NAME = "inertia-remote-companion";
const STORE_NAME = "device";
const PROFILE_KEY = "active";
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

export async function loadDeviceProfile(): Promise<BrowserDeviceProfile | null> {
  const db = await database();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME)
        .get(PROFILE_KEY);
      request.onsuccess = () => resolve(request.result as unknown);
      request.onerror = () => reject(request.error);
    });
    if (raw === undefined) return null;
    const parsed = browserDeviceProfileSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    await deleteProfile(db);
    throw new Error(
      "The stored Remote Companion profile was invalid and has been cleared.",
    );
  } finally {
    db.close();
  }
}

export async function saveDeviceProfile(
  profile: BrowserDeviceProfile,
): Promise<void> {
  const validated = browserDeviceProfileSchema.parse(profile);
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(validated, PROFILE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function clearDeviceProfile(): Promise<void> {
  const db = await database();
  try {
    await deleteProfile(db);
  } finally {
    db.close();
  }
}

function deleteProfile(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(PROFILE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
