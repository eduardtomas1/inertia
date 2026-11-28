import { backendSecretReferenceForProfile } from "./backend-secret-reference";
import { isBackendCredentialGeneration, isBackendCredentialSecret, isBackendSecretReference } from "../shared/backend-credentials";

export const CURSOR_SDK_CREDENTIAL_PROFILE_ID = "cursor-sdk";
export const CURSOR_SDK_SECRET_REFERENCE = backendSecretReferenceForProfile(CURSOR_SDK_CREDENTIAL_PROFILE_ID);
export type RuntimeCredentialOperation = "resolve" | "status" | "clear" | "forget" | "save";
export type RuntimeCredentialFailureCode = "not-found" | "unavailable" | "invalid";
export type RuntimeCredentialRequest = {
  type: "runtime.credential-request"; requestId: string; secretReference: string;
} & ({ operation: Exclude<RuntimeCredentialOperation, "save"> } | { operation: "save"; secret: string });
export type RuntimeCredentialResult =
  | { type: "runtime.credential-result"; requestId: string; operation: "resolve"; ok: true; secret: string }
  | { type: "runtime.credential-result"; requestId: string; operation: "status" | "save"; ok: true; hasSecret: boolean; credentialGeneration: string | null }
  | { type: "runtime.credential-result"; requestId: string; operation: "clear" | "forget"; ok: true; removed: boolean }
  | { type: "runtime.credential-result"; requestId: string; operation: RuntimeCredentialOperation; ok: false; code: RuntimeCredentialFailureCode; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const operations = new Set(["resolve", "status", "clear", "forget", "save"]);

/** Private main/runtime IPC only. Saving is restricted to the native SDK account. */
export function parseRuntimeCredentialRequest(value: Record<string, unknown>): RuntimeCredentialRequest | null {
  if (value.type !== "runtime.credential-request" || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || !isBackendSecretReference(value.secretReference) || !operations.has(String(value.operation))) return null;
  if (value.operation === "save") {
    if (Object.keys(value).length !== 5 || value.secretReference !== CURSOR_SDK_SECRET_REFERENCE || !isBackendCredentialSecret(value.secret)) return null;
    return { type: value.type, requestId: value.requestId, secretReference: value.secretReference, operation: "save", secret: value.secret };
  }
  if (Object.keys(value).length !== 4) return null;
  return { type: value.type, requestId: value.requestId, secretReference: value.secretReference,
    operation: value.operation as Exclude<RuntimeCredentialOperation, "save"> };
}

export function parseRuntimeCredentialResult(value: Record<string, unknown>): RuntimeCredentialResult | null {
  if (value.type !== "runtime.credential-result" || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || !operations.has(String(value.operation)) || typeof value.ok !== "boolean") return null;
  if (!value.ok) {
    if (Object.keys(value).length !== 6 || !["not-found", "unavailable", "invalid"].includes(String(value.code))
      || typeof value.message !== "string" || !value.message.trim() || value.message.trim().length > 300) return null;
    return { type: value.type, requestId: value.requestId, operation: value.operation as RuntimeCredentialOperation, ok: false,
      code: value.code as RuntimeCredentialFailureCode, message: value.message.trim() };
  }
  if (value.operation === "resolve" && Object.keys(value).length === 5 && isBackendCredentialSecret(value.secret)) {
    return { type: value.type, requestId: value.requestId, operation: "resolve", ok: true, secret: value.secret };
  }
  if ((value.operation === "status" || value.operation === "save") && Object.keys(value).length === 6
    && typeof value.hasSecret === "boolean" && (value.credentialGeneration === null || isBackendCredentialGeneration(value.credentialGeneration))) {
    return { type: value.type, requestId: value.requestId, operation: value.operation, ok: true,
      hasSecret: value.hasSecret, credentialGeneration: value.credentialGeneration };
  }
  if ((value.operation === "clear" || value.operation === "forget") && Object.keys(value).length === 5 && typeof value.removed === "boolean") {
    return { type: value.type, requestId: value.requestId, operation: value.operation, ok: true, removed: value.removed };
  }
  return null;
}
