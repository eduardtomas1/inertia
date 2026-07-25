export const BACKEND_CREDENTIAL_MASK = "••••••••";
export const MAX_BACKEND_CREDENTIAL_LENGTH = 16_384;

export type BackendCredentialStorageProvider =
  | "keychain"
  | "dpapi"
  | "secret-service"
  | "unavailable";

export interface BackendCredentialStorageState {
  available: boolean;
  provider: BackendCredentialStorageProvider;
  message: string | null;
}

export interface BackendCredentialState {
  profileId: string;
  hasSecret: boolean;
  maskedValue: typeof BACKEND_CREDENTIAL_MASK | null;
  /** Opaque non-secret mutation identity; null only before the first write/clear. */
  credentialGeneration: string | null;
  storage: BackendCredentialStorageState;
}

export interface BackendCredentialStatus {
  hasSecret: boolean;
  credentialGeneration: string | null;
}

export interface SetBackendCredentialRequest {
  profileId: string;
  secret: string;
}

export interface BackendCredentialProfileRequest {
  profileId: string;
}

const PROFILE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/u;
const SECRET_REFERENCE_PATTERN = /^secret:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const CREDENTIAL_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isBackendCredentialProfileId(value: unknown): value is string {
  return typeof value === "string" && PROFILE_ID_PATTERN.test(value);
}

export function isBackendSecretReference(value: unknown): value is string {
  return typeof value === "string" && SECRET_REFERENCE_PATTERN.test(value);
}

export function isBackendCredentialGeneration(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL_GENERATION_PATTERN.test(value);
}

export function isBackendCredentialSecret(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_BACKEND_CREDENTIAL_LENGTH
    && value.trim().length > 0
    && value !== BACKEND_CREDENTIAL_MASK
    && !/[\0\r\n]/u.test(value);
}

export function parseSetBackendCredentialRequest(
  value: unknown,
): SetBackendCredentialRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2
    || !isBackendCredentialProfileId(candidate.profileId)
    || !isBackendCredentialSecret(candidate.secret)
  ) return null;
  return {
    profileId: candidate.profileId,
    secret: candidate.secret,
  };
}

export function parseBackendCredentialProfileRequest(
  value: unknown,
): BackendCredentialProfileRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 1
    || !isBackendCredentialProfileId(candidate.profileId)
  ) return null;
  return { profileId: candidate.profileId };
}
