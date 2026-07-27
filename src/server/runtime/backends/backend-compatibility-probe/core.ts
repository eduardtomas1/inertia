import type {
  BackendCompatibilityProbeRequest,
  BackendProbeFailureCode,
} from "../../../../shared/backend-probe";
import type {
  ModelBackendProtocol,
  ModelCapability,
  ModelCapabilityId,
  ModelCapabilityProvenance,
} from "../../../../shared/model-routing";

export const DEFAULT_TIMEOUT_MS = 7_500;
export const MAX_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface BackendProbeResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface NativeBackendProbeObservation {
  protocolVerified: boolean;
  modelVerified: boolean;
  capabilities?: readonly ModelCapability[];
  contextWindowTokens?: number | null;
  contextWindowProvenance?: Exclude<ModelCapabilityProvenance, "unknown"> | null;
  contextWindowDetail?: string | null;
}

export interface NativeBackendProbeAdapter {
  probe(
    input: {
      profileId: string;
      protocol: Extract<ModelBackendProtocol, "cursor-managed" | "opencode-native">;
      modelId: string;
    },
    signal: AbortSignal,
  ): Promise<NativeBackendProbeObservation>;
}

export interface BackendCompatibilityProbeDependencies {
  resolveCredential?: (
    secretReference: string,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  resolveAddresses?: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly BackendProbeResolvedAddress[]>;
  nativeAdapters?: Partial<Record<
    Extract<ModelBackendProtocol, "cursor-managed" | "opencode-native">,
    NativeBackendProbeAdapter
  >>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}

export interface ProbeObservation {
  protocolVerified: boolean;
  modelVerified: boolean;
  observedCapabilities: readonly ModelCapability[];
  contextWindowTokens: number | null;
  contextWindowProvenance: ModelCapabilityProvenance | null;
  contextWindowDetail: string | null;
}

export class BackendProbeError extends Error {
  constructor(
    readonly code: BackendProbeFailureCode,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "BackendProbeError";
  }
}

export const FIXED_FAILURE_MESSAGES: Readonly<Record<BackendProbeFailureCode, string>> = {
  "invalid-url": "The backend endpoint URL is invalid.",
  "insecure-url": "The backend endpoint must use HTTPS.",
  "private-network": "The backend endpoint resolves to a blocked network address.",
  "unsafe-redirect": "Backend probe redirects are not allowed.",
  "credential-unavailable": "The backend credential is unavailable.",
  "invalid-credentials": "The backend rejected the configured credential.",
  "unreachable": "The backend could not be reached.",
  "timeout": "The backend probe timed out.",
  "response-too-large": "The backend returned an oversized probe response.",
  "malformed-response": "The backend returned an invalid protocol response.",
  "missing-model": "The selected model is unavailable on this backend.",
  "unsupported-protocol": "The backend does not support the expected protocol.",
  "rate-limited": "The backend rate limit prevented verification.",
  "server-error": "The backend reported a server error.",
  "cancelled": "The backend probe was cancelled.",
};

export function normalizeProbeError(
  error: unknown,
  timedOut: boolean,
  externallyAborted: boolean,
): BackendProbeError {
  if (timedOut) return new BackendProbeError("timeout", FIXED_FAILURE_MESSAGES.timeout);
  if (externallyAborted) return new BackendProbeError("cancelled", FIXED_FAILURE_MESSAGES.cancelled);
  if (error instanceof BackendProbeError) return error;
  return new BackendProbeError("unreachable", FIXED_FAILURE_MESSAGES.unreachable);
}

export function validContextProvenance(value: unknown): ModelCapabilityProvenance {
  if (value === undefined || value === null) return "provider";
  if (
    value === "provider"
    || value === "harness"
    || value === "probe"
    || value === "user"
    || value === "built-in"
  ) return value;
  throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new BackendProbeError("cancelled", FIXED_FAILURE_MESSAGES.cancelled));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new BackendProbeError("cancelled", FIXED_FAILURE_MESSAGES.cancelled));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function unknownCapability(id: ModelCapabilityId): ModelCapability {
  return { id, state: "unknown", provenance: "unknown", detail: null };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BackendProbeError("cancelled", FIXED_FAILURE_MESSAGES.cancelled);
  }
}

export function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 && field.length <= 500
    ? field
    : null;
}

export function boundedDetail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/gu, " ").slice(0, 1_000);
  return normalized || null;
}

export function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

export type HttpBackendProtocol = Extract<
  BackendCompatibilityProbeRequest["profile"]["protocol"],
  "anthropic-messages" | "openai-responses"
>;
