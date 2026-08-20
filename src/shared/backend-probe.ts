import { z } from "zod";

import {
  MODEL_CAPABILITY_IDS,
  modelBackendProfileSchema,
  modelCapabilitySchema,
  modelCapabilityStateSchema,
  type ModelBackendProfile,
  type ModelBackendProtocol,
  type ModelCapability,
  type ModelCapabilityId,
  type ModelCapabilityProvenance,
  type ModelCapabilityState,
} from "./model-routing";

export const BACKEND_PROBE_FAILURE_CODES = [
  "invalid-url",
  "insecure-url",
  "private-network",
  "unsafe-redirect",
  "credential-unavailable",
  "invalid-credentials",
  "unreachable",
  "timeout",
  "response-too-large",
  "malformed-response",
  "missing-model",
  "unsupported-protocol",
  "rate-limited",
  "server-error",
  "cancelled",
] as const;

export type BackendProbeFailureCode = (typeof BACKEND_PROBE_FAILURE_CODES)[number];
export type BackendProbeCompatibility = "protocol-compatible" | "partially-compatible" | "unavailable";

export interface BackendProbeCapabilityEvidence extends ModelCapability {
  checkedAt: string;
}

export interface BackendProbeContextEvidence {
  tokens: number | null;
  state: ModelCapabilityState;
  provenance: ModelCapabilityProvenance;
  detail: string | null;
  checkedAt: string;
}

export interface BackendProbeFailure {
  code: BackendProbeFailureCode;
  message: string;
  retryAfterSeconds: number | null;
}

/**
 * Safe, renderer-eligible compatibility request. It carries only an opaque
 * credential reference; secret materialization belongs to the privileged
 * runtime probe boundary.
 */
export interface BackendCompatibilityProbeRequest {
  profile: ModelBackendProfile;
  endpointUrl: string | null;
  modelId: string;
  secretReference: string | null;
  allowInsecureLocalhost: boolean;
  capabilityHints: readonly ModelCapability[];
  contextWindowHint: {
    tokens: number;
    provenance: Exclude<ModelCapabilityProvenance, "unknown">;
    detail: string | null;
  } | null;
}

export interface BackendCompatibilityProbeResult {
  profileId: string;
  backendConfigurationRevision: number;
  endpointIdentity: string | null;
  protocol: ModelBackendProtocol;
  modelId: string;
  compatibility: BackendProbeCompatibility;
  protocolVerified: boolean;
  modelVerified: boolean;
  capabilities: readonly BackendProbeCapabilityEvidence[];
  contextWindow: BackendProbeContextEvidence;
  failure: BackendProbeFailure | null;
  checkedAt: string;
}

const timestampSchema = z.string().datetime({ offset: true });
const modelIdSchema = z.string().trim().min(1).max(500)
  .refine((value) => !/[\0\r\n]/u.test(value), "Model IDs cannot contain control characters.");
const secretReferenceSchema = z.string()
  .min(8)
  .max(200)
  .regex(/^secret:[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const capabilityHintSchema = modelCapabilitySchema.refine(
  (capability) => capability.provenance !== "probe",
  "Probe evidence cannot be supplied as a hint.",
);

export const backendCompatibilityProbeRequestSchema = z.object({
  profile: modelBackendProfileSchema,
  endpointUrl: z.string().trim().min(1).max(2_048).nullable(),
  modelId: modelIdSchema,
  secretReference: secretReferenceSchema.nullable(),
  allowInsecureLocalhost: z.boolean(),
  capabilityHints: z.array(capabilityHintSchema).max(32),
  contextWindowHint: z.object({
    tokens: z.number().int().positive().max(100_000_000),
    provenance: z.enum(["provider", "harness", "user", "built-in"]),
    detail: z.string().max(1_000).nullable(),
  }).strict().nullable(),
}).strict().superRefine((request, context) => {
  const ids = new Set<ModelCapabilityId>();
  for (const [index, capability] of request.capabilityHints.entries()) {
    if (ids.has(capability.id)) {
      context.addIssue({
        code: "custom",
        path: ["capabilityHints", index, "id"],
        message: "Capability hints must have unique identifiers.",
      });
    }
    ids.add(capability.id);
  }
  const needsCredential = request.profile.authenticationMode === "api-key"
    || request.profile.authenticationMode === "bearer-token";
  if (needsCredential && request.secretReference === null) {
    context.addIssue({
      code: "custom",
      path: ["secretReference"],
      message: "This backend authentication mode requires a credential reference.",
    });
  }
  if (!needsCredential && request.secretReference !== null) {
    context.addIssue({
      code: "custom",
      path: ["secretReference"],
      message: "This backend authentication mode does not accept a credential reference.",
    });
  }
  if (
    request.profile.source === "custom"
    && (
      request.profile.protocol === "anthropic-messages"
      || request.profile.protocol === "openai-responses"
    )
    && request.profile.endpointIdentity === null
  ) {
    context.addIssue({
      code: "custom",
      path: ["profile", "endpointIdentity"],
      message: "Custom HTTP backends require a stable endpoint identity.",
    });
  }
});

export const backendProbeCapabilityEvidenceSchema = modelCapabilitySchema.extend({
  checkedAt: timestampSchema,
}).strict();

export const backendCompatibilityProbeResultSchema = z.object({
  profileId: z.string().min(1).max(200),
  backendConfigurationRevision: z.number().int().nonnegative(),
  endpointIdentity: z.string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
    .nullable(),
  protocol: z.enum([
    "openai-responses",
    "anthropic-messages",
    "cursor-managed",
    "kimi-managed",
    "opencode-native",
  ]),
  modelId: modelIdSchema,
  compatibility: z.enum(["protocol-compatible", "partially-compatible", "unavailable"]),
  protocolVerified: z.boolean(),
  modelVerified: z.boolean(),
  capabilities: z.array(backendProbeCapabilityEvidenceSchema).length(MODEL_CAPABILITY_IDS.length),
  contextWindow: z.object({
    tokens: z.number().int().positive().max(100_000_000).nullable(),
    state: modelCapabilityStateSchema,
    provenance: z.enum(["provider", "harness", "probe", "user", "built-in", "unknown"]),
    detail: z.string().max(1_000).nullable(),
    checkedAt: timestampSchema,
  }).strict(),
  failure: z.object({
    code: z.enum(BACKEND_PROBE_FAILURE_CODES),
    message: z.string().min(1).max(300),
    retryAfterSeconds: z.number().int().nonnegative().max(86_400).nullable(),
  }).strict().nullable(),
  checkedAt: timestampSchema,
}).strict();

/**
 * Task 24 consumes probe evidence only while this complete binding still
 * matches. Replacing an endpoint must change its endpoint identity and/or
 * configuration revision, making prior evidence ineligible.
 */
export function backendProbeMatchesProfile(
  result: BackendCompatibilityProbeResult,
  profile: ModelBackendProfile,
  modelId: string,
): boolean {
  const parsedResult = backendCompatibilityProbeResultSchema.safeParse(result);
  const parsedProfile = modelBackendProfileSchema.safeParse(profile);
  return parsedResult.success
    && parsedProfile.success
    && parsedResult.data.profileId === parsedProfile.data.id
    && parsedResult.data.backendConfigurationRevision
      === parsedProfile.data.configurationRevision
    && parsedResult.data.endpointIdentity === parsedProfile.data.endpointIdentity
    && parsedResult.data.protocol === parsedProfile.data.protocol
    && parsedResult.data.modelId === modelId;
}
