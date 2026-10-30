import { SECRET_REQUEST_STORAGES, type SecretRequestStorage } from "../shared/agent-secrets.js";

export interface RuntimeAgentSecretDeliverCommand {
  type: "runtime.agent-secret-deliver";
  transportId: string;
  conversationId: string;
  requestId: string;
  secret: string;
  vaulted: boolean;
}

export const AGENT_SECRET_RECONCILE_MAX_REQUESTS = 256;

export interface RuntimeAgentSecretReconcileCommand {
  type: "runtime.agent-secret-reconcile";
  transportId: string;
  requestIds: string[];
}

export type RuntimeAgentSecretCommand = RuntimeAgentSecretDeliverCommand | RuntimeAgentSecretReconcileCommand;

export const RUNTIME_AGENT_SECRET_REJECTION_REASONS = ["not-pending", "ended", "file-failed", "limit", "invalid"] as const;
export type RuntimeAgentSecretRejectionReason = (typeof RUNTIME_AGENT_SECRET_REJECTION_REASONS)[number];

export type RuntimeAgentSecretEvent =
  | { type: "runtime.agent-secret-delivered"; transportId: string; expiresAt: string; storage: SecretRequestStorage }
  | { type: "runtime.agent-secret-rejected"; transportId: string; reason: RuntimeAgentSecretRejectionReason }
  | { type: "runtime.agent-secret-reconciled"; transportId: string; orphaned: string[] };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_IDENTITY_LENGTH = 128;

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function requestIds(value: unknown, minimum: number): value is string[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.length <= AGENT_SECRET_RECONCILE_MAX_REQUESTS
    && value.every(uuid)
    && new Set(value).size === value.length;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function parseRuntimeAgentSecretDeliverCommand(value: unknown): RuntimeAgentSecretDeliverCommand | null {
  if (
    !plainObject(value)
    || value.type !== "runtime.agent-secret-deliver"
    || Object.keys(value).length !== 6
    || !uuid(value.transportId)
    || !identity(value.conversationId)
    || !identity(value.requestId)
    || typeof value.secret !== "string"
    || typeof value.vaulted !== "boolean"
  ) return null;
  return {
    type: "runtime.agent-secret-deliver",
    transportId: value.transportId,
    conversationId: value.conversationId,
    requestId: value.requestId,
    secret: value.secret,
    vaulted: value.vaulted,
  };
}

export function parseRuntimeAgentSecretCommand(value: unknown): RuntimeAgentSecretCommand | null {
  if (
    plainObject(value)
    && value.type === "runtime.agent-secret-reconcile"
    && Object.keys(value).length === 3
    && uuid(value.transportId)
    && requestIds(value.requestIds, 1)
  ) {
    return { type: "runtime.agent-secret-reconcile", transportId: value.transportId, requestIds: [...value.requestIds] };
  }
  return parseRuntimeAgentSecretDeliverCommand(value);
}

export function parseRuntimeAgentSecretEvent(value: unknown): RuntimeAgentSecretEvent | null {
  if (!plainObject(value) || !uuid(value.transportId)) return null;
  if (
    value.type === "runtime.agent-secret-delivered"
    && Object.keys(value).length === 4
    && timestamp(value.expiresAt)
    && includes(SECRET_REQUEST_STORAGES, value.storage)
  ) {
    return { type: "runtime.agent-secret-delivered", transportId: value.transportId, expiresAt: value.expiresAt, storage: value.storage };
  }
  if (
    value.type === "runtime.agent-secret-rejected"
    && Object.keys(value).length === 3
    && includes(RUNTIME_AGENT_SECRET_REJECTION_REASONS, value.reason)
  ) {
    return { type: "runtime.agent-secret-rejected", transportId: value.transportId, reason: value.reason };
  }
  if (
    value.type === "runtime.agent-secret-reconciled"
    && Object.keys(value).length === 3
    && requestIds(value.orphaned, 0)
  ) {
    return { type: "runtime.agent-secret-reconciled", transportId: value.transportId, orphaned: [...value.orphaned] };
  }
  return null;
}
