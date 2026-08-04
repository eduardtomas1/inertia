import { z } from "zod";

import {
  privateConnectConversationGrantsSchema,
  privateConnectConversationGrantSchema,
  type PrivateConnectConversationGrant,
} from "./grants";
import {
  privateConnectPresetSchema,
  privateConnectScopeSchema,
  type PrivateConnectPreset,
  type PrivateConnectScope,
} from "./scopes";

export const PRIVATE_CONNECT_PROTOCOL_VERSION = 1 as const;
export const PRIVATE_CONNECT_PROTOCOL_RANGE = Object.freeze({
  minimum: PRIVATE_CONNECT_PROTOCOL_VERSION,
  maximum: PRIVATE_CONNECT_PROTOCOL_VERSION,
});

export const PRIVATE_CONNECT_LIMITS = Object.freeze({
  bodyBytes: 128 * 1024,
  websocketFrameBytes: 128 * 1024,
  promptCharacters: 8_000,
  deviceLabelCharacters: 80,
  projectIds: 64,
  sessions: 8,
  requestsPerMinute: 120,
  pairingAttemptsPerMinute: 10,
  pairingTtlMs: 5 * 60 * 1_000,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
  websocketTicketTtlMs: 45_000,
  auditEvents: 1_000,
});

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const entityId = z.string().trim().min(1).max(200);
const validator = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const privateConnectConversationGrant =
  privateConnectConversationGrantSchema;

export const privateConnectInvitationSchema = z.object({
  protocolVersion: z.literal(PRIVATE_CONNECT_PROTOCOL_VERSION),
  hostId: uuid,
  invitationId: uuid,
  pairingSecret: secret,
  createdAt: timestamp,
  expiresAt: timestamp,
}).strict();
export type PrivateConnectInvitation = z.infer<
  typeof privateConnectInvitationSchema
>;

export const privateConnectRequestSchema = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: z.literal(PRIVATE_CONNECT_PROTOCOL_VERSION),
    type: z.literal("state.get"),
    requestId: uuid,
    ifNoneMatch: validator.nullable().optional(),
  }).strict(),
  z.object({
    protocolVersion: z.literal(PRIVATE_CONNECT_PROTOCOL_VERSION),
    type: z.literal("conversation.get"),
    requestId: uuid,
    conversationId: uuid,
    ifNoneMatch: validator.nullable().optional(),
  }).strict(),
  z.object({
    protocolVersion: z.literal(PRIVATE_CONNECT_PROTOCOL_VERSION),
    type: z.literal("prompt.send"),
    requestId: uuid,
    deliveryId: uuid,
    conversationId: uuid,
    content: z.string().trim().min(1).max(PRIVATE_CONNECT_LIMITS.promptCharacters),
  }).strict(),
  z.object({
    protocolVersion: z.literal(PRIVATE_CONNECT_PROTOCOL_VERSION),
    type: z.literal("input.respond"),
    requestId: uuid,
    conversationId: uuid,
    inputRequestId: uuid,
    answers: z.record(z.string().min(1).max(80), z.array(entityId).min(1).max(32))
      .refine((value) => Object.keys(value).length <= 32),
  }).strict(),
  z.object({
    protocolVersion: z.literal(PRIVATE_CONNECT_PROTOCOL_VERSION),
    type: z.literal("run.stop"),
    requestId: uuid,
    conversationId: uuid,
    runId: entityId,
  }).strict(),
  z.object({
    protocolVersion: z.literal(PRIVATE_CONNECT_PROTOCOL_VERSION),
    type: z.literal("session.logout"),
    requestId: uuid,
  }).strict(),
  z.object({
    protocolVersion: z.literal(PRIVATE_CONNECT_PROTOCOL_VERSION),
    type: z.literal("client.ping"),
    requestId: uuid,
  }).strict(),
]);
export type PrivateConnectRequest = z.infer<typeof privateConnectRequestSchema>;

export const privateConnectSafeProjectSchema = z.object({
  id: entityId,
  name: z.string().max(240),
}).strict();
export type PrivateConnectSafeProject = z.infer<
  typeof privateConnectSafeProjectSchema
>;

export const privateConnectSafeConversationSchema = z.object({
  id: entityId,
  projectId: entityId,
  title: z.string().max(240),
  providerLabel: z.string().max(240),
  status: z.enum(["idle", "running", "needs-input", "completed", "failed"]),
  pendingLocalApproval: z.boolean(),
  pendingLocalAction: z.boolean(),
  updatedAt: timestamp,
}).strict();
export type PrivateConnectSafeConversation = z.infer<
  typeof privateConnectSafeConversationSchema
>;

export const privateConnectSafeMessageSchema = z.object({
  id: entityId,
  turnId: entityId.nullable(),
  role: z.enum(["user", "assistant"]),
  content: z.string().max(64 * 1024),
  createdAt: timestamp,
}).strict();
export type PrivateConnectSafeMessage = z.infer<
  typeof privateConnectSafeMessageSchema
>;

export const privateConnectSafeQuestionSchema = z.object({
  id: uuid,
  label: z.string().max(240),
  options: z.array(z.object({
    id: entityId,
    label: z.string().max(240),
  }).strict()).max(32),
  allowMultiple: z.boolean(),
}).strict();
export type PrivateConnectSafeQuestion = z.infer<
  typeof privateConnectSafeQuestionSchema
>;

export const privateConnectStateSchema = z.object({
  generatedAt: timestamp,
  projects: z.array(privateConnectSafeProjectSchema).max(1_000),
  conversations: z.array(privateConnectSafeConversationSchema).max(5_000),
  capabilities: z.object({
    scopes: z.array(privateConnectScopeSchema).max(4),
    preset: privateConnectPresetSchema,
    expiresAt: timestamp,
  }).strict(),
}).strict();
export type PrivateConnectState = z.infer<typeof privateConnectStateSchema>;

export const privateConnectConversationDetailSchema = z.object({
  generatedAt: timestamp,
  conversation: privateConnectSafeConversationSchema,
  messages: z.array(privateConnectSafeMessageSchema).max(200),
  questions: z.array(privateConnectSafeQuestionSchema).max(32),
  waitingForLocalAction: z.boolean(),
}).strict();
export type PrivateConnectConversationDetail = z.infer<
  typeof privateConnectConversationDetailSchema
>;

export const privateConnectAuthorizationSchema = z.object({
  deviceId: uuid,
  sessionId: uuid,
  scopes: z.array(privateConnectScopeSchema).min(1).max(4),
  projectIds: z.array(entityId).min(1).max(PRIVATE_CONNECT_LIMITS.projectIds),
  grants: privateConnectConversationGrantsSchema,
  grantVersion: z.number().int().positive(),
  expiresAt: timestamp,
}).strict();
export type PrivateConnectAuthorization = z.infer<
  typeof privateConnectAuthorizationSchema
>;

export interface PrivateConnectDeviceView {
  id: string;
  label: string;
  preset: PrivateConnectPreset;
  scopes: PrivateConnectScope[];
  projectIds: string[];
  grants: PrivateConnectConversationGrant[];
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface PrivateConnectPendingPairingView {
  requestId: string;
  deviceLabel: string;
  comparisonCode: string;
  receivedAt: string;
  expiresAt: string;
  tailnetLabel: string | null;
}

export interface PrivateConnectDiagnostics {
  tailscale: "not-installed" | "not-running" | "logged-out" | "connected" | "unknown";
  magicDns: "available" | "unavailable" | "unknown";
  gatewayPort: number | null;
  servePort: number | null;
  externalUrl: string | null;
  mappingOwnership: "owned" | "missing" | "unrelated" | "unknown";
  errorClass: string | null;
  setupUrl?: string | null;
}

export interface PrivateConnectStateView {
  available: boolean;
  enabled: boolean;
  status: "off" | "starting" | "ready" | "error";
  statusMessage: string | null;
  externalUrl: string | null;
  activeSessions: number;
  devices: PrivateConnectDeviceView[];
  pendingPairings: PrivateConnectPendingPairingView[];
  invitation: { url: string; expiresAt: string } | null;
  notice: string | null;
  diagnostics: PrivateConnectDiagnostics;
}

export type PrivateConnectResponse =
  | { type: "response"; requestId: string; ok: true; result: unknown }
  | { type: "response"; requestId: string; ok: false; code: "forbidden" | "not-found" | "busy" | "stale" | "rate-limited" | "invalid" | "unavailable" | "uncertain"; message: string };
