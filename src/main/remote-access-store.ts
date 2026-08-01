import { z } from "zod";
import type { SafeStorage } from "electron";

import {
  REMOTE_LIMITS,
  remoteConversationGrantsSchema,
  remoteScopeSchema,
  type RemoteAuditEvent,
  type RemoteScope,
} from "../shared/remote-protocol";
import type { RemoteSerializedKeyPair } from "../shared/remote-crypto";
import {
  normalizeRemoteConversationGrants,
  remoteConversationGrantsFromProjectIds,
  type RemoteConversationGrant,
} from "../shared/remote-grants";
import {
  ElectronSafeStorageBackend,
  FileCredentialVaultPersistence,
  type CredentialVaultPersistence,
} from "./credential-vault";

const timestamp = z.string().datetime({ offset: true });
const entityId = z.string().min(1).max(200);
const keyMaterial = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u);
const AUTHORITY_REDUCTION_MARKER = "inertia-remote-authority-reduction-v1";

const persistedDeviceSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(80),
  publicKey: keyMaterial,
  scopes: z.array(remoteScopeSchema).min(1).max(2),
  projectIds: z.array(entityId).min(1).max(64),
  grants: remoteConversationGrantsSchema.optional(),
  createdAt: timestamp,
  expiresAt: timestamp,
  lastSeenAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
  grantVersion: z.number().int().positive(),
}).strict().transform((device) => ({
  ...device,
  grants: normalizeRemoteConversationGrants(
    device.grants
      ?? remoteConversationGrantsFromProjectIds(device.projectIds),
  ),
}));

const auditEventSchema = z.object({
  id: z.string().uuid(),
  type: z.enum([
    "remote.enabled",
    "remote.disabled",
    "pairing.created",
    "pairing.requested",
    "pairing.accepted",
    "pairing.denied",
    "device.revoked",
    "device.scope-changed",
    "session.connected",
    "session.disconnected",
    "prompt.accepted",
    "prompt.uncertain",
    "request.rejected",
  ]),
  deviceId: z.string().uuid().nullable(),
  detail: z.string().min(1).max(240),
  createdAt: timestamp,
}).strict();

const deliveryReceiptSchema = z.object({
  deliveryId: z.string().uuid(),
  deviceId: z.string().uuid(),
  conversationId: entityId,
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  state: z.enum(["dispatched", "accepted", "uncertain"]),
  turnId: entityId.nullable(),
  createdAt: timestamp,
}).strict();

const usedSessionSchema = z.object({
  id: z.string().uuid(),
  createdAt: timestamp,
}).strict();

const remoteStoreSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  relayUrl: z.string().max(2_048),
  hostId: z.string().uuid(),
  endpointId: keyMaterial,
  keyPair: z.object({
    publicKey: keyMaterial,
    privateKey: keyMaterial,
  }).strict(),
  devices: z.array(persistedDeviceSchema).max(REMOTE_LIMITS.devices),
  audit: z.array(auditEventSchema).max(REMOTE_LIMITS.auditEvents),
  receipts: z.array(deliveryReceiptSchema).max(REMOTE_LIMITS.deliveryReceipts),
  usedSessions: z.array(usedSessionSchema).max(REMOTE_LIMITS.deliveryReceipts)
    .default([]),
}).strict();

export interface PersistedRemoteDevice {
  id: string;
  label: string;
  publicKey: string;
  scopes: RemoteScope[];
  projectIds: string[];
  grants: RemoteConversationGrant[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  grantVersion: number;
}

export interface RemoteDeliveryReceipt {
  deliveryId: string;
  deviceId: string;
  conversationId: string;
  contentDigest: string;
  state: "dispatched" | "accepted" | "uncertain";
  turnId: string | null;
  createdAt: string;
}

export interface PersistedRemoteAccess {
  version: 1;
  enabled: boolean;
  relayUrl: string;
  hostId: string;
  endpointId: string;
  keyPair: RemoteSerializedKeyPair;
  devices: PersistedRemoteDevice[];
  audit: RemoteAuditEvent[];
  receipts: RemoteDeliveryReceipt[];
  usedSessions: Array<{ id: string; createdAt: string }>;
}

export interface RemoteStoreEncryption {
  available(): boolean;
  encrypt(plaintext: string): Uint8Array;
  decrypt(ciphertext: Uint8Array): string;
}

type RemoteSafeStorage = Pick<
  SafeStorage,
  | "decryptString"
  | "decryptStringAsync"
  | "encryptString"
  | "encryptStringAsync"
  | "getSelectedStorageBackend"
  | "isAsyncEncryptionAvailable"
>;

export async function createRemoteStoreEncryption(
  storage: RemoteSafeStorage,
  platform: NodeJS.Platform = process.platform,
  availabilityTimeoutMs = 1_500,
): Promise<RemoteStoreEncryption> {
  const backend = new ElectronSafeStorageBackend(storage, platform);
  const availability = await boundedStorageAvailability(
    backend,
    availabilityTimeoutMs,
  );
  return {
    available: () => availability.available,
    encrypt: (plaintext) => {
      if (!availability.available) {
        throw new Error("Secure platform storage is unavailable.");
      }
      return storage.encryptString(plaintext);
    },
    decrypt: (ciphertext) => {
      if (!availability.available) {
        throw new Error("Secure platform storage is unavailable.");
      }
      return storage.decryptString(Buffer.from(ciphertext));
    },
  };
}

async function boundedStorageAvailability(
  backend: ElectronSafeStorageBackend,
  timeoutMs: number,
): Promise<Awaited<ReturnType<ElectronSafeStorageBackend["availability"]>>> {
  return await new Promise((resolveAvailability) => {
    let settled = false;
    const finish = (
      value: Awaited<ReturnType<ElectronSafeStorageBackend["availability"]>>,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveAvailability(value);
    };
    const timer = setTimeout(() => {
      finish({
        available: false,
        provider: "unavailable",
        message: "Secure credential storage is unavailable on this system.",
      });
    }, Math.max(1, Math.min(timeoutMs, 5_000)));
    timer.unref();
    void backend.availability().then(finish);
  });
}

export class RemoteAccessStore {
  private readonly persistence: CredentialVaultPersistence;
  private readonly authorityReduction: FileCredentialVaultPersistence;
  private authorityReductionDepth = 0;
  private authorityReductionReady: Promise<void> | null = null;
  private authorityReductionCleanup: Promise<void> | null = null;

  constructor(
    filePath: string,
    private readonly encryption: RemoteStoreEncryption,
    persistence?: CredentialVaultPersistence,
  ) {
    this.persistence = persistence ?? new FileCredentialVaultPersistence(
      filePath,
      { temporaryPrefix: ".remote-access-vault-" },
    );
    this.authorityReduction = new FileCredentialVaultPersistence(
      `${filePath}.fail-closed`,
      { temporaryPrefix: ".remote-access-fail-closed-" },
    );
  }

  available(): boolean {
    return this.encryption.available();
  }

  async load(): Promise<PersistedRemoteAccess | null> {
    if (!this.available()) return null;
    const authorityReduction = await this.authorityReduction.read();
    if (
      authorityReduction !== null
      && authorityReduction !== AUTHORITY_REDUCTION_MARKER
    ) {
      throw new Error("The Remote Companion fail-closed marker is invalid.");
    }
    const encoded = await this.persistence.read();
    if (encoded === null) {
      if (authorityReduction !== null) await this.authorityReduction.remove();
      return null;
    }
    if (
      encoded.length > 1_400_000
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
    ) throw new Error("The encrypted Remote Companion store is invalid.");
    const encrypted = Buffer.from(encoded, "base64");
    const parsed = remoteStoreSchema.safeParse(
      JSON.parse(this.encryption.decrypt(encrypted)) as unknown,
    );
    if (!parsed.success) {
      throw new Error("The encrypted Remote Companion store is invalid.");
    }
    if (authorityReduction === null) return parsed.data;
    const failClosed: PersistedRemoteAccess = {
      ...parsed.data,
      enabled: false,
      devices: [],
      receipts: [],
      usedSessions: [],
    };
    await this.save(failClosed);
    await this.authorityReduction.remove();
    return failClosed;
  }

  async save(value: PersistedRemoteAccess): Promise<void> {
    if (!this.available()) {
      throw new Error("Secure platform storage is unavailable.");
    }
    const validated = remoteStoreSchema.parse(value);
    const encrypted = this.encryption.encrypt(JSON.stringify(validated));
    await this.persistence.write(
      Buffer.from(encrypted).toString("base64"),
    );
  }

  async beginAuthorityReduction(): Promise<void> {
    if (this.authorityReductionCleanup) {
      await this.authorityReductionCleanup;
    }
    this.authorityReductionDepth += 1;
    this.authorityReductionReady ??= this.authorityReduction.write(
      AUTHORITY_REDUCTION_MARKER,
    );
    try {
      await this.authorityReductionReady;
    } catch (error) {
      this.authorityReductionDepth -= 1;
      if (this.authorityReductionDepth === 0) {
        this.authorityReductionReady = null;
      }
      throw error;
    }
  }

  async completeAuthorityReduction(): Promise<void> {
    if (this.authorityReductionDepth < 1 || !this.authorityReductionReady) {
      throw new Error("No Remote Companion authority reduction is active.");
    }
    await this.authorityReductionReady;
    if (this.authorityReductionDepth < 1) {
      throw new Error("No Remote Companion authority reduction is active.");
    }
    this.authorityReductionDepth -= 1;
    if (this.authorityReductionDepth > 0) return;
    const completedGeneration = this.authorityReductionReady;
    const cleanup = this.authorityReduction.remove();
    this.authorityReductionCleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.authorityReductionCleanup === cleanup) {
        this.authorityReductionCleanup = null;
      }
      if (this.authorityReductionReady === completedGeneration) {
        this.authorityReductionReady = null;
      }
    }
  }
}
