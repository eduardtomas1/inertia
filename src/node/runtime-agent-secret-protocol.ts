import { isAgentSecretValue, SECRET_REQUEST_STORAGES, type SecretRequestStorage } from "../shared/agent-secrets.js";

export interface RuntimeAgentSecretDeliverCommand {
  type: "runtime.agent-secret-deliver";
  transportId: string;
  conversationId: string;
  requestId: string;
  secret: string;
  vaulted: boolean;
}

export const RUNTIME_AGENT_SECRET_REJECTION_REASONS = ["not-pending", "ended", "file-failed", "limit"] as const;
export type RuntimeAgentSecretRejectionReason = (typeof RUNTIME_AGENT_SECRET_REJECTION_REASONS)[number];

export type RuntimeAgentSecretEvent =
  | { type: "runtime.agent-secret-delivered"; transportId: string; expiresAt: string; storage: SecretRequestStorage }
  | { type: "runtime.agent-secret-rejected"; transportId: string; reason: RuntimeAgentSecretRejectionReason };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function parseRuntimeAgentSecretDeliverCommand(value: unknown): RuntimeAgentSecretDeliverCommand | null {
  if (
    !plainObject(value)
    || value.type !== "runtime.agent-secret-deliver"
    || Object.keys(value).length !== 6
    || !uuid(value.transportId)
    || !uuid(value.conversationId)
    || !uuid(value.requestId)
    || !isAgentSecretValue(value.secret)
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
  return null;
}
