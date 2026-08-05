import { z } from "zod";
import type { SafeStorage } from "electron";

import {
  privateConnectConversationGrantsSchema,
  type PrivateConnectConversationGrant,
} from "../../shared/private-connect/grants";
import {
  PRIVATE_CONNECT_LIMITS,
} from "../../shared/private-connect/protocol";
import {
  privateConnectScopeSchema,
  type PrivateConnectScope,
} from "../../shared/private-connect/scopes";
import {
  ElectronSafeStorageBackend,
  FileCredentialVaultPersistence,
  type CredentialVaultPersistence,
} from "../credential-vault";

const timestamp = z.string().datetime({ offset: true });
const entityId = z.string().trim().min(1).max(200);

const privateConnectDeviceSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(80),
  scopes: z.array(privateConnectScopeSchema).min(1).max(4),
  projectIds: z.array(entityId).min(1).max(PRIVATE_CONNECT_LIMITS.projectIds),
  grants: privateConnectConversationGrantsSchema,
  createdAt: timestamp,
  expiresAt: timestamp,
  lastSeenAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
  grantVersion: z.number().int().positive(),
}).strict();

const privateConnectSessionSchema = z.object({
  id: z.string().uuid(),
  tokenDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  deviceId: z.string().uuid(),
  expiresAt: timestamp,
  grantVersion: z.number().int().positive(),
}).strict();

const privateConnectAcceptedDeliveryReceiptSchema = z.object({
  deliveryId: z.string().uuid(),
  conversationId: z.string().uuid(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  response: z.object({
    type: z.literal("response"),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    result: z.object({
      kind: z.literal("prompt.accepted"),
      deliveryId: z.string().uuid(),
      turnId: entityId,
    }).strict(),
  }).strict(),
}).strict();

const privateConnectUncertainDeliveryReceiptSchema = z.object({
  deliveryId: z.string().uuid(),
  conversationId: z.string().uuid(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  uncertainAt: timestamp,
}).strict();

const privateConnectDeliveryReceiptSchema = z.union([
  privateConnectAcceptedDeliveryReceiptSchema,
  privateConnectUncertainDeliveryReceiptSchema,
]);

const privateConnectAuditSchema = z.object({
  id: z.string().uuid(),
  type: z.enum([
    "enabled",
    "disabled",
    "pairing.created",
    "pairing.requested",
    "pairing.accepted",
    "pairing.denied",
    "device.revoked",
    "device.scope-changed",
    "authority.recovered",
    "serve.ownership-warning",
    "session.connected",
    "session.disconnected",
    "prompt.accepted",
    "prompt.uncertain",
    "request.rejected",
  ]),
  deviceId: z.string().uuid().nullable(),
  detail: z.string().trim().min(1).max(240),
  createdAt: timestamp,
}).strict();

const privateConnectStoreSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  hostId: z.string().uuid(),
  servePort: z.number().int().min(1).max(65_535).nullable(),
  serveTarget: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u).nullable().default(null),
  grantGeneration: z.number().int().positive(),
  pendingAuthorityReduction: z.object({
    generation: z.number().int().positive(),
    createdAt: timestamp,
  }).strict().nullable().default(null),
  devices: z.array(privateConnectDeviceSchema).max(16),
  sessions: z.array(privateConnectSessionSchema).max(PRIVATE_CONNECT_LIMITS.sessions),
  deliveryReceipts: z.array(privateConnectDeliveryReceiptSchema).max(PRIVATE_CONNECT_LIMITS.deliveryReceipts).default([]),
  audit: z.array(privateConnectAuditSchema).max(PRIVATE_CONNECT_LIMITS.auditEvents),
  migrationNoticeShown: z.boolean(),
}).strict();

export interface PrivateConnectDevice {
  id: string;
  label: string;
  scopes: PrivateConnectScope[];
  projectIds: string[];
  grants: PrivateConnectConversationGrant[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  grantVersion: number;
}

export interface PrivateConnectSessionRecord {
  id: string;
  tokenDigest: string;
  deviceId: string;
  expiresAt: string;
  grantVersion: number;
}

export interface PrivateConnectAuditEvent {
  id: string;
  type: z.infer<typeof privateConnectAuditSchema>["type"];
  deviceId: string | null;
  detail: string;
  createdAt: string;
}

export interface PersistedPrivateConnect {
  version: 1;
  enabled: boolean;
  hostId: string;
  servePort: number | null;
  serveTarget: string | null;
  grantGeneration: number;
  pendingAuthorityReduction?: {
    generation: number;
    createdAt: string;
  } | null;
  devices: PrivateConnectDevice[];
  sessions: PrivateConnectSessionRecord[];
  deliveryReceipts: PrivateConnectDeliveryReceipt[];
  audit: PrivateConnectAuditEvent[];
  migrationNoticeShown: boolean;
}

export interface PrivateConnectAcceptedDeliveryReceipt {
  deliveryId: string;
  conversationId: string;
  contentDigest: string;
  response: {
    type: "response";
    requestId: string;
    ok: true;
    result: { kind: "prompt.accepted"; deliveryId: string; turnId: string };
  };
}

export interface PrivateConnectUncertainDeliveryReceipt {
  deliveryId: string;
  conversationId: string;
  contentDigest: string;
  uncertainAt: string;
}

export type PrivateConnectDeliveryReceipt =
  | PrivateConnectAcceptedDeliveryReceipt
  | PrivateConnectUncertainDeliveryReceipt;

export interface PrivateConnectStoreEncryption {
  available(): boolean;
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}

type PrivateConnectSafeStorage = Pick<
  SafeStorage,
  "decryptString" | "decryptStringAsync" | "encryptString" | "encryptStringAsync" | "getSelectedStorageBackend" | "isAsyncEncryptionAvailable"
>;

export async function createPrivateConnectStoreEncryption(
  storage: PrivateConnectSafeStorage,
  platform: NodeJS.Platform = process.platform,
  availabilityTimeoutMs = 1_500,
): Promise<PrivateConnectStoreEncryption> {
  const backend = new ElectronSafeStorageBackend(storage, platform);
  const available = await Promise.race([
    backend.availability(),
    new Promise<Awaited<ReturnType<ElectronSafeStorageBackend["availability"]>>>((resolve) => {
      const timer = setTimeout(() => resolve({ available: false, provider: "unavailable", message: "Secure storage is unavailable." }), availabilityTimeoutMs);
      timer.unref?.();
    }),
  ]);
  return {
    available: () => available.available,
    encrypt: (value) => {
      if (!available.available) throw new Error("Secure platform storage is unavailable.");
      return storage.encryptString(value);
    },
    decrypt: (value) => {
      if (!available.available) throw new Error("Secure platform storage is unavailable.");
      return storage.decryptString(Buffer.from(value));
    },
  };
}

export class PrivateConnectStore {
  private readonly persistence: CredentialVaultPersistence;

  constructor(
    private readonly filePath: string,
    private readonly encryption: PrivateConnectStoreEncryption,
    persistence?: CredentialVaultPersistence,
  ) {
    this.persistence = persistence ?? new FileCredentialVaultPersistence(filePath, {
      temporaryPrefix: ".private-connect-vault-",
    });
  }

  available(): boolean { return this.encryption.available(); }

  async load(): Promise<PersistedPrivateConnect | null> {
    if (!this.available()) return null;
    const encoded = await this.persistence.read();
    if (encoded === null) return null;
    if (encoded.length > 1_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
      throw new Error("The encrypted Private Connect store is invalid.");
    }
    try {
      const decoded = this.encryption.decrypt(Buffer.from(encoded, "base64"));
      return privateConnectStoreSchema.parse(JSON.parse(decoded) as unknown);
    } catch {
      throw new Error("The encrypted Private Connect store could not be opened.");
    }
  }

  async save(value: PersistedPrivateConnect): Promise<void> {
    if (!this.available()) throw new Error("Secure platform storage is unavailable.");
    const encoded = Buffer.from(this.encryption.encrypt(JSON.stringify(privateConnectStoreSchema.parse(value)))).toString("base64");
    await this.persistence.write(encoded);
  }

  path(): string { return this.filePath; }
}
