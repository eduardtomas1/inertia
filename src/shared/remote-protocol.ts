import { z } from "zod";

import remoteComponentVersions from "../../remote/component-versions.json";

import {
  REMOTE_GRANT_LIMITS,
  type RemoteConversationGrant,
} from "./remote-grants";

export const REMOTE_PROTOCOL_VERSION = 2 as const;
export const RELAY_PROTOCOL_VERSION = 2 as const;
export const REMOTE_BROWSER_VERSION = remoteComponentVersions.browser;
export const REMOTE_RELAY_VERSION = remoteComponentVersions.relay;
export const REMOTE_DESKTOP_VERSION = remoteComponentVersions.desktop;
export const REMOTE_AUTHENTICATED_REJECTION_CAPABILITY = "auth-reject-v1";
export const REMOTE_CONDITIONAL_PROJECTIONS_CAPABILITY =
  "conditional-projections-v1";
export const REMOTE_CONDITIONAL_PROJECTIONS_BROWSER_VERSION =
  REMOTE_BROWSER_VERSION;
// Keep the authenticated-rejection marker stable for mixed desktop/browser
// versions. Conditional reads are negotiated separately through the relay's
// authenticated component-version projection.
export const REMOTE_BROWSER_SESSION_VERSION =
  `0.2.0+${REMOTE_AUTHENTICATED_REJECTION_CAPABILITY}`;
export const RELAY_PROTOCOL_RANGE = Object.freeze({ minimum: 2, maximum: 2 });
export const REMOTE_PROTOCOL_RANGE = Object.freeze({ minimum: 2, maximum: 2 });

export const REMOTE_LIMITS = Object.freeze({
  relayEnvelopeBytes: 132 * 1024,
  // A 96 KiB plaintext plus the AES-GCM tag, base64url expansion, and maximum
  // session-data JSON fields fits below this frame bound. The wrapped relay
  // envelope in turn fits below relayEnvelopeBytes.
  encryptedFrameBytes: 130 * 1024,
  plaintextBytes: 96 * 1024,
  promptCharacters: 8_000,
  transcriptMessages: 200,
  activities: 200,
  subagents: 64,
  devices: 16,
  sessions: 4,
  sessionRejectionAuthentications: 8,
  connections: 8,
  pendingPairings: 1,
  queuedFramesPerConnection: 16,
  inFlightRequestsPerSession: 8,
  requestsPerMinute: 120,
  promptRequestsPerMinute: 6,
  pairingAttemptsPerMinute: 10,
  sessionAuthenticationAttemptsPerMinute: 24,
  sessionAuthenticationAttemptsPerConnection: 4,
  pairingTtlMs: 5 * 60 * 1_000,
  sessionHandshakeTtlMs: 60 * 1_000,
  sessionIdleTtlMs: 15 * 60 * 1_000,
  reconnectMaximumMs: 30 * 1_000,
  auditEvents: 1_000,
  deliveryReceipts: 512,
} as const);

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const entityId = z.string().min(1).max(200);
const boundedBase64Url = (maximum: number) =>
  z.string().min(1).max(maximum).regex(/^[A-Za-z0-9_-]+$/u);
const routingId = boundedBase64Url(64);
const componentVersion = z.string().trim().min(1).max(40).regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
);
export const remoteProtocolRangeSchema = z.object({
  minimum: z.number().int().positive(),
  maximum: z.number().int().positive(),
}).strict().refine(({ minimum, maximum }) => maximum >= minimum);
export type RemoteProtocolRange = z.infer<typeof remoteProtocolRangeSchema>;

const componentCompatibilitySchema = <Kind extends "browser" | "desktop" | "relay">(
  kind: Kind,
) => z.object({
  kind: z.literal(kind),
  version: componentVersion,
  relayProtocol: remoteProtocolRangeSchema,
  remoteProtocol: remoteProtocolRangeSchema,
}).strict();

export const remoteBrowserCompatibilitySchema =
  componentCompatibilitySchema("browser");
export const remoteDesktopCompatibilitySchema =
  componentCompatibilitySchema("desktop");
export const remoteRelayCompatibilitySchema =
  componentCompatibilitySchema("relay");
export type RemoteBrowserCompatibility = z.infer<
  typeof remoteBrowserCompatibilitySchema
>;
export type RemoteDesktopCompatibility = z.infer<
  typeof remoteDesktopCompatibilitySchema
>;
export type RemoteRelayCompatibility = z.infer<
  typeof remoteRelayCompatibilitySchema
>;

export const REMOTE_BROWSER_COMPATIBILITY: RemoteBrowserCompatibility = {
  kind: "browser",
  version: REMOTE_BROWSER_VERSION,
  relayProtocol: RELAY_PROTOCOL_RANGE,
  remoteProtocol: REMOTE_PROTOCOL_RANGE,
};
export const REMOTE_DESKTOP_COMPATIBILITY: RemoteDesktopCompatibility = {
  kind: "desktop",
  version: REMOTE_DESKTOP_VERSION,
  relayProtocol: RELAY_PROTOCOL_RANGE,
  remoteProtocol: REMOTE_PROTOCOL_RANGE,
};
// Base64url is ASCII, so this character bound is also an encoded-byte bound.
// The sender and receiver separately enforce the complete serialized frame.
const encryptedBody = boundedBase64Url(REMOTE_LIMITS.encryptedFrameBytes);
const encapsulatedKey = boundedBase64Url(256);

export const remoteScopeSchema = z.enum(["view", "prompt"]);
export type RemoteScope = z.infer<typeof remoteScopeSchema>;

export const remoteConversationGrantSchema = z.object({
  projectId: entityId,
  conversationIds: z.array(entityId).max(
    REMOTE_GRANT_LIMITS.conversationsPerProject,
  ),
  includeFutureConversations: z.boolean(),
  legacyProjectWide: z.boolean(),
}).strict();

export const remoteConversationGrantsSchema = z
  .array(remoteConversationGrantSchema)
  .max(REMOTE_GRANT_LIMITS.projects);

export const remotePairingInvitationSchema = z.object({
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  relayUrl: z.string().url().max(2_048),
  relayIdentity: uuid,
  desktop: remoteDesktopCompatibilitySchema,
  endpointId: routingId,
  hostId: uuid,
  hostPublicKey: boundedBase64Url(256),
  invitationId: uuid,
  pairingSecret: boundedBase64Url(128),
  expiresAt: timestamp,
}).strict();
export type RemotePairingInvitation = z.infer<
  typeof remotePairingInvitationSchema
>;

export const remotePairingRequestPayloadSchema = z.object({
  type: z.literal("pair.request"),
  requestId: uuid,
  invitationId: uuid,
  deviceId: uuid,
  deviceLabel: z.string().trim().min(1).max(80),
  devicePublicKey: boundedBase64Url(256),
  createdAt: timestamp,
  browserVersion: z.string().trim().min(1).max(40),
}).strict();
export type RemotePairingRequestPayload = z.infer<
  typeof remotePairingRequestPayloadSchema
>;

export const remotePairingResponsePayloadSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("pair.accepted"),
      requestId: uuid,
      deviceId: uuid,
      hostId: uuid,
      scopes: z.array(remoteScopeSchema).min(1).max(2),
      projectIds: z.array(z.string().min(1).max(200)).min(1).max(64),
      expiresAt: timestamp,
      grantVersion: z.number().int().positive(),
    }).strict(),
    z.object({
      type: z.literal("pair.rejected"),
      requestId: uuid,
      reason: z.enum(["denied", "expired", "mismatch", "unavailable"]),
    }).strict(),
  ],
);
export type RemotePairingResponsePayload = z.infer<
  typeof remotePairingResponsePayloadSchema
>;

export const remoteSessionOpenPayloadSchema = z.object({
  type: z.literal("session.open"),
  sessionId: uuid,
  deviceId: uuid,
  grantVersion: z.number().int().positive(),
  createdAt: timestamp,
  browserVersion: z.string().min(1).max(40).regex(
    /^\d+\.\d+\.\d+(?:\+[a-z0-9]+(?:-[a-z0-9]+)*)?$/u,
  ),
}).strict();
export type RemoteSessionOpenPayload = z.infer<
  typeof remoteSessionOpenPayloadSchema
>;

export const remoteSessionAcceptPayloadSchema = z.object({
  type: z.literal("session.accept"),
  sessionId: uuid,
  hostId: uuid,
  grantVersion: z.number().int().positive(),
  scopes: z.array(remoteScopeSchema).min(1).max(2),
  projectIds: z.array(z.string().min(1).max(200)).min(1).max(64),
  expiresAt: timestamp,
  serverTime: timestamp,
}).strict();
export type RemoteSessionAcceptPayload = z.infer<
  typeof remoteSessionAcceptPayloadSchema
>;

export const remoteSessionRejectPayloadSchema = z.object({
  type: z.literal("session.reject"),
  sessionId: uuid,
  hostId: uuid,
  reason: z.enum(["revoked", "expired"]),
  serverTime: timestamp,
}).strict();
export type RemoteSessionRejectPayload = z.infer<
  typeof remoteSessionRejectPayloadSchema
>;

export const remoteSessionAuthorityChangedPayloadSchema = z.object({
  type: z.literal("session.authority-changed"),
  serverTime: timestamp,
}).strict();
export type RemoteSessionAuthorityChangedPayload = z.infer<
  typeof remoteSessionAuthorityChangedPayloadSchema
>;

export const remoteSessionResponsePayloadSchema = z.discriminatedUnion(
  "type",
  [remoteSessionAcceptPayloadSchema, remoteSessionRejectPayloadSchema],
);
export type RemoteSessionResponsePayload = z.infer<
  typeof remoteSessionResponsePayloadSchema
>;

const pairingRequestFrameSchema = z.object({
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  kind: z.literal("pair.request"),
  invitationId: uuid,
  enc: encapsulatedKey,
  ciphertext: encryptedBody,
}).strict();

const pairingResponseFrameSchema = z.object({
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  kind: z.literal("pair.response"),
  requestId: uuid,
  enc: encapsulatedKey,
  ciphertext: encryptedBody,
}).strict();

const sessionOpenFrameSchema = z.object({
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  kind: z.literal("session.open"),
  sessionId: uuid,
  enc: encapsulatedKey,
  ciphertext: encryptedBody,
}).strict();

const sessionAcceptFrameSchema = z.object({
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  kind: z.literal("session.accept"),
  sessionId: uuid,
  enc: encapsulatedKey,
  ciphertext: encryptedBody,
}).strict();

const sessionDataFrameSchema = z.object({
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  kind: z.literal("session.data"),
  sessionId: uuid,
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ciphertext: encryptedBody,
}).strict();

const sessionCloseFrameSchema = z.object({
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  kind: z.literal("session.close"),
  sessionId: uuid,
  reason: z.enum([
    "disabled",
    "expired",
    "revoked",
    "replay",
    "rate-limited",
    "protocol-error",
    "shutdown",
  ]),
}).strict();

export const remoteCipherFrameSchema = z.discriminatedUnion("kind", [
  pairingRequestFrameSchema,
  pairingResponseFrameSchema,
  sessionOpenFrameSchema,
  sessionAcceptFrameSchema,
  sessionDataFrameSchema,
  sessionCloseFrameSchema,
]);
export type RemoteCipherFrame = z.infer<typeof remoteCipherFrameSchema>;

const relaySelectedVersionsSchema = z.object({
  relayProtocol: z.number().int().positive(),
  remoteProtocol: z.number().int().positive(),
}).strict();

const relayEndpointChallengeSchema = z.object({
  purpose: z.enum(["claim", "register"]),
  relayIdentity: uuid,
  endpointId: routingId,
  endpointPublicKey: boundedBase64Url(256),
  nonce: boundedBase64Url(64),
  epoch: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict();
export type RelayEndpointChallenge = z.infer<
  typeof relayEndpointChallengeSchema
>;

const relayGuidanceSchema = z.object({
  action: z.enum(["upgrade", "downgrade"]),
  component: z.enum(["browser", "desktop", "relay"]),
  requiredProtocol: remoteProtocolRangeSchema,
}).strict();

export const relayIncompatibilitySchema = z.object({
  relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
  type: z.literal("relay.incompatible"),
  axis: z.enum(["relay-protocol", "remote-protocol"]),
  reason: z.enum([
    "client-too-old",
    "client-too-new",
    "relay-too-old",
    "relay-too-new",
  ]),
  component: z.enum(["browser", "desktop", "relay"]),
  received: remoteProtocolRangeSchema,
  supported: remoteProtocolRangeSchema,
  guidance: z.array(relayGuidanceSchema).max(3),
}).strict();
export type RelayIncompatibility = z.infer<typeof relayIncompatibilitySchema>;

export const relayClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.claim.begin"),
    endpointId: routingId,
    endpointPublicKey: boundedBase64Url(256),
    desktop: remoteDesktopCompatibilitySchema,
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.register.begin"),
    endpointId: routingId,
    desktop: remoteDesktopCompatibilitySchema,
  }).strict(),
  relayEndpointChallengeSchema.extend({
    type: z.literal("relay.register.proof"),
    signature: boundedBase64Url(128),
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.connect"),
    endpointId: routingId,
    browser: remoteBrowserCompatibilitySchema,
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.origin.probe"),
    browser: remoteBrowserCompatibilitySchema,
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.frame"),
    connectionId: uuid,
    frame: remoteCipherFrameSchema,
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.disconnect"),
    connectionId: uuid,
  }).strict(),
]);
export type RelayClientMessage = z.infer<typeof relayClientMessageSchema>;

export const relayServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.hello"),
    relayVersion: componentVersion,
    relayIdentity: uuid,
    relayProtocol: remoteProtocolRangeSchema,
    remoteProtocol: remoteProtocolRangeSchema,
    endpointAuthentication: z.enum(["required", "migration"]),
    persistence: z.enum(["durable", "ephemeral"]),
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.register.challenge"),
    relayProtocol: remoteProtocolRangeSchema,
    remoteProtocol: remoteProtocolRangeSchema,
    ...relayEndpointChallengeSchema.shape,
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.registered"),
    ownership: z.enum(["claimed", "verified", "taken-over"]),
    endpointEpoch: z.number().int().positive(),
    lastConnectedAt: timestamp.nullable(),
    selected: relaySelectedVersionsSchema,
    versions: z.object({
      relay: componentVersion,
      desktop: componentVersion,
    }).strict(),
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.origin.accepted"),
    relayVersion: componentVersion,
    relayProtocol: remoteProtocolRangeSchema,
    remoteProtocol: remoteProtocolRangeSchema,
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.connected"),
    connectionId: uuid,
    endpointEpoch: z.number().int().positive(),
    relayIdentity: uuid,
    selected: relaySelectedVersionsSchema,
    versions: z.object({
      relay: componentVersion,
      desktop: componentVersion,
      browser: componentVersion,
    }).strict(),
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.peer-connected"),
    connectionId: uuid,
    endpointEpoch: z.number().int().positive(),
    relayIdentity: uuid,
    selected: relaySelectedVersionsSchema,
    versions: z.object({
      relay: componentVersion,
      desktop: componentVersion,
      browser: componentVersion,
    }).strict(),
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.frame"),
    connectionId: uuid,
    endpointEpoch: z.number().int().positive(),
    frame: remoteCipherFrameSchema,
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.peer-disconnected"),
    connectionId: uuid,
    endpointEpoch: z.number().int().positive(),
  }).strict(),
  z.object({
    relayProtocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.error"),
    code: z.enum([
      "invalid-message",
      "desktop-offline",
      "connection-missing",
      "capacity",
      "rate-limited",
      "challenge-expired",
      "endpoint-missing",
      "endpoint-owned",
      "proof-invalid",
      "storage-unavailable",
    ]),
  }).strict(),
  relayIncompatibilitySchema,
]);
export type RelayServerMessage = z.infer<typeof relayServerMessageSchema>;

const safeLabel = z.string().max(240);
const safeContent = z.string().max(64 * 1024);

export const remoteSafeProjectSchema = z.object({
  id: entityId,
  name: safeLabel,
}).strict();
export type RemoteSafeProject = z.infer<typeof remoteSafeProjectSchema>;

export const remoteSafeConversationSchema = z.object({
  id: entityId,
  projectId: entityId,
  title: safeLabel,
  providerLabel: safeLabel,
  status: z.enum(["idle", "running", "needs-input", "completed", "failed"]),
  pendingLocalApproval: z.boolean(),
  promptSafety: z.object({
    supported: z.boolean(),
    headline: safeLabel,
    explanation: z.string().max(600),
  }).strict(),
  updatedAt: timestamp,
}).strict();
export type RemoteSafeConversation = z.infer<
  typeof remoteSafeConversationSchema
>;

export const remoteSafeRunSchema = z.object({
  id: entityId,
  conversationId: entityId.nullable(),
  label: safeLabel,
  status: z.enum(["running", "waiting", "succeeded", "failed", "cancelled"]),
}).strict();
export type RemoteSafeRun = z.infer<typeof remoteSafeRunSchema>;

export const remoteSafeShellSchema = z.object({
  generatedAt: timestamp,
  projects: z.array(remoteSafeProjectSchema).max(1_000),
  conversations: z.array(remoteSafeConversationSchema).max(5_000),
  runs: z.array(remoteSafeRunSchema).max(REMOTE_LIMITS.activities),
}).strict();
export type RemoteSafeShell = z.infer<typeof remoteSafeShellSchema>;

export const remoteSafeMessageSchema = z.object({
  id: entityId,
  turnId: entityId.nullable(),
  role: z.enum(["user", "assistant"]),
  content: safeContent,
  createdAt: timestamp,
}).strict();
export type RemoteSafeMessage = z.infer<typeof remoteSafeMessageSchema>;

export const remoteSafeActivitySchema = z.object({
  id: entityId,
  turnId: entityId.nullable(),
  kind: z.enum(["status", "tool", "command", "file", "reasoning", "error"]),
  title: safeLabel,
  status: z.enum(["running", "completed", "failed"]),
  createdAt: timestamp,
}).strict();
export type RemoteSafeActivity = z.infer<typeof remoteSafeActivitySchema>;

export const remoteSafeSubagentSchema = z.object({
  id: entityId,
  turnId: entityId,
  providerLabel: safeLabel,
  name: safeLabel.nullable(),
  status: safeLabel,
  description: safeContent.nullable(),
  progress: safeContent.nullable(),
  updatedAt: timestamp,
}).strict();
export type RemoteSafeSubagent = z.infer<typeof remoteSafeSubagentSchema>;

export const remoteSafeConversationDetailSchema = z.object({
  generatedAt: timestamp,
  conversation: remoteSafeConversationSchema,
  messages: z.array(remoteSafeMessageSchema).max(REMOTE_LIMITS.transcriptMessages),
  activities: z.array(remoteSafeActivitySchema).max(REMOTE_LIMITS.activities),
  subagents: z.array(remoteSafeSubagentSchema).max(REMOTE_LIMITS.subagents),
  waitingForLocalAction: z.boolean(),
}).strict();
export type RemoteSafeConversationDetail = z.infer<
  typeof remoteSafeConversationDetailSchema
>;

export const remoteProjectionValidatorSchema = boundedBase64Url(43).length(43);
export type RemoteProjectionValidator = z.infer<
  typeof remoteProjectionValidatorSchema
>;

const conditionalProjectionRead = {
  ifNoneMatch: remoteProjectionValidatorSchema.nullable().optional(),
};

export const remoteRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("state.get"),
    requestId: uuid,
    ...conditionalProjectionRead,
  }).strict(),
  z.object({
    type: z.literal("conversation.get"),
    requestId: uuid,
    conversationId: uuid,
    ...conditionalProjectionRead,
  }).strict(),
  z.object({
    type: z.literal("prompt.send"),
    requestId: uuid,
    deliveryId: uuid,
    conversationId: uuid,
    content: z.string().trim().min(1).max(REMOTE_LIMITS.promptCharacters),
  }).strict(),
]);
export type RemoteRequest = z.infer<typeof remoteRequestSchema>;

export const remoteResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("response"),
    requestId: uuid,
    ok: z.literal(true),
    result: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("state"),
        validator: remoteProjectionValidatorSchema.optional(),
        state: remoteSafeShellSchema,
      }).strict(),
      z.object({
        kind: z.literal("conversation"),
        validator: remoteProjectionValidatorSchema.optional(),
        detail: remoteSafeConversationDetailSchema,
      }).strict(),
      z.object({
        kind: z.literal("not-modified"),
        validator: remoteProjectionValidatorSchema,
        checkedAt: timestamp,
        resource: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("state") }).strict(),
          z.object({
            kind: z.literal("conversation"),
            conversationId: uuid,
          }).strict(),
        ]),
      }).strict(),
      z.object({
        kind: z.literal("prompt.accepted"),
        deliveryId: uuid,
        turnId: z.string().min(1).max(200),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    type: z.literal("response"),
    requestId: uuid,
    ok: z.literal(false),
    code: z.enum([
      "forbidden",
      "not-found",
      "busy",
      "stale",
      "rate-limited",
      "invalid",
      "unavailable",
      "uncertain",
    ]),
    message: z.string().trim().min(1).max(300),
  }).strict(),
]);
export type RemoteResponse = z.infer<typeof remoteResponseSchema>;

export function remoteVersionSupportsConditionalProjections(
  version: string,
): boolean {
  const current = componentVersion.safeParse(version);
  const required = componentVersion.parse(
    REMOTE_CONDITIONAL_PROJECTIONS_BROWSER_VERSION,
  );
  if (!current.success) return false;
  const left = current.data.split(".").map(Number);
  const right = required.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

export const remoteAuthorizationSubjectSchema = z.object({
  deviceId: uuid,
  sessionId: uuid,
  scopes: z.array(remoteScopeSchema).min(1).max(2),
  projectIds: z.array(entityId).min(1).max(64),
  grants: remoteConversationGrantsSchema,
  grantVersion: z.number().int().positive(),
  expiresAt: timestamp,
}).strict();
export type RemoteAuthorizationSubject = z.infer<
  typeof remoteAuthorizationSubjectSchema
>;

export interface RemoteDeviceView {
  id: string;
  label: string;
  scopes: RemoteScope[];
  projectIds: string[];
  grants: RemoteConversationGrant[];
  needsGrantReview: boolean;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface RemotePendingPairingView {
  requestId: string;
  deviceLabel: string;
  comparisonCode: string;
  receivedAt: string;
  expiresAt: string;
  replacesDeviceLabel: string | null;
}

export interface RemoteAuditEvent {
  id: string;
  type:
    | "remote.enabled"
    | "remote.disabled"
    | "pairing.created"
    | "pairing.requested"
    | "pairing.accepted"
    | "pairing.denied"
    | "device.revoked"
    | "device.scope-changed"
    | "session.connected"
    | "session.disconnected"
    | "prompt.accepted"
    | "prompt.uncertain"
    | "request.rejected";
  deviceId: string | null;
  detail: string;
  createdAt: string;
}

export type RemoteSetupMode = "local-development" | "self-hosted";

export interface RemoteSetupDiagnostics {
  status: "untested" | "testing" | "passed" | "failed";
  testedAt: string | null;
  transport: "loopback-development" | "wss" | null;
  tls: "not-applicable" | "verified" | "failed" | null;
  originPolicy: "accepted" | "rejected" | "unknown";
  relayVersion: string | null;
  browserVersion: string | null;
  desktopVersion: string;
  relayProtocol: number | null;
  remoteProtocol: number | null;
  endpointAuthentication: "required" | "migration" | null;
  persistence: "durable" | "ephemeral" | null;
  endpointOwnership:
    | "unclaimed"
    | "verified"
    | "missing"
    | "owned-by-another-key";
  endpointEpoch: number | null;
  lastConnectedAt: string | null;
  retryClass: "none" | "automatic" | "manual";
  failureClass:
    | "none"
    | "configuration"
    | "network"
    | "tls-certificate"
    | "origin-policy"
    | "browser-headers"
    | "compatibility"
    | "endpoint-authentication"
    | "relay-storage";
  message: string | null;
}

export interface RemoteAccessState {
  available: boolean;
  enabled: boolean;
  relayUrl: string;
  setupMode: RemoteSetupMode;
  companionUrl: string;
  diagnostics: RemoteSetupDiagnostics;
  connection:
    | "disabled"
    | "connecting"
    | "online"
    | "offline"
    | "error";
  connectionMessage: string | null;
  activeSessions: number;
  devices: RemoteDeviceView[];
  pendingPairings: RemotePendingPairingView[];
  invitation: RemotePairingInvitation | null;
  audit: RemoteAuditEvent[];
}

export function encodedRemoteFrameBytes(frame: RemoteCipherFrame): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}
