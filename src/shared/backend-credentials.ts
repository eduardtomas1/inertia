export const BACKEND_CREDENTIAL_MASK = "••••••••";
export const MAX_BACKEND_CREDENTIAL_LENGTH = 16_384;
export const DISCORD_RELEASE_WEBHOOK_PROFILE_ID = "discord-release-webhook";

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
  /** Optional safe incident reference; never a credential or vault error. */
  diagnosticId?: string;
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

export function backendCredentialSecretIssue(value: unknown): string | null {
  if (typeof value !== "string") return "Paste the API key or token as text.";
  if (value.length > MAX_BACKEND_CREDENTIAL_LENGTH) {
    return "The API key or token is longer than 16,384 characters.";
  }
  const secret = value.trim();
  if (secret.length === 0) {
    return "Paste an API key or token. Only spaces or line breaks were entered.";
  }
  if (secret === BACKEND_CREDENTIAL_MASK) {
    return "Paste a new API key or token. The masked placeholder cannot be saved.";
  }
  if (/[\0\r\n]/u.test(secret)) {
    return "The API key or token must be on a single line.";
  }
  return null;
}

export function normalizeBackendCredentialSecret(value: unknown): string {
  const issue = backendCredentialSecretIssue(value);
  if (issue !== null) throw new Error(issue);
  return (value as string).trim();
}

export function parseSetBackendCredentialRequest(
  value: unknown,
): SetBackendCredentialRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2
    || !isBackendCredentialProfileId(candidate.profileId)
    || backendCredentialSecretIssue(candidate.secret) !== null
  ) return null;
  const secret = normalizeBackendCredentialSecret(candidate.secret);
  if (!isBackendCredentialSecret(secret)) return null;
  return {
    profileId: candidate.profileId,
    secret,
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
