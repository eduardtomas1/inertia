import {
  backendCompatibilityProbeRequestSchema,
  backendCompatibilityProbeResultSchema,
  type BackendCompatibilityProbeRequest,
  type BackendCompatibilityProbeResult,
  type BackendProbeCapabilityEvidence,
  type BackendProbeContextEvidence,
  type BackendProbeFailure,
} from "../../../shared/backend-probe";
import { MODEL_CAPABILITY_IDS } from "../../../shared/model-routing";
import {
  BackendProbeError,
  clampInteger,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  FIXED_FAILURE_MESSAGES,
  MAX_RESPONSE_BYTES,
  MAX_TIMEOUT_MS,
  normalizeProbeError,
  unknownCapability,
  type BackendCompatibilityProbeDependencies,
  type ProbeObservation,
} from "./backend-compatibility-probe/core";
import { probeHttpBackend } from "./backend-compatibility-probe/http";
import {
  nativeModelCatalogProbeAdapter,
  probeNativeBackend,
} from "./backend-compatibility-probe/native";

export type {
  BackendCompatibilityProbeDependencies,
  BackendProbeResolvedAddress,
  NativeBackendProbeAdapter,
  NativeBackendProbeObservation,
} from "./backend-compatibility-probe/core";
export { nativeModelCatalogProbeAdapter };

export async function probeBackendCompatibility(
  requestInput: BackendCompatibilityProbeRequest,
  dependencies: BackendCompatibilityProbeDependencies = {},
  externalSignal?: AbortSignal,
): Promise<BackendCompatibilityProbeResult> {
  const request = backendCompatibilityProbeRequestSchema.parse(requestInput);
  const checkedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const timeoutMs = clampInteger(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const maxResponseBytes = clampInteger(
    dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    1,
    MAX_RESPONSE_BYTES,
  );
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  const onExternalAbort = (): void => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    let observation: ProbeObservation;
    if (
      request.profile.protocol === "anthropic-messages"
      || request.profile.protocol === "openai-responses"
    ) {
      observation = await probeHttpBackend(
        request,
        dependencies,
        controller.signal,
        maxResponseBytes,
      );
    } else {
      observation = await probeNativeBackend(request, dependencies, controller.signal);
    }
    return resultForObservation(request, observation, checkedAt);
  } catch (error) {
    const normalized = normalizeProbeError(error, timedOut, externalSignal?.aborted === true);
    return resultForFailure(request, normalized, checkedAt);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function resultForObservation(
  request: BackendCompatibilityProbeRequest,
  observation: ProbeObservation,
  checkedAt: string,
): BackendCompatibilityProbeResult {
  const hints = new Map(request.capabilityHints.map((capability) => [capability.id, capability]));
  for (const observed of observation.observedCapabilities) hints.set(observed.id, observed);
  const capabilities: BackendProbeCapabilityEvidence[] = MODEL_CAPABILITY_IDS.map((id) => {
    const evidence = hints.get(id) ?? unknownCapability(id);
    return { ...evidence, checkedAt };
  });
  const contextWindow = contextEvidence(request, observation, checkedAt);
  const unknownCapabilities = capabilities.some((capability) => (
    capability.state === "unknown" || capability.state === "user-declared"
  ));
  return backendCompatibilityProbeResultSchema.parse({
    profileId: request.profile.id,
    backendConfigurationRevision: request.profile.configurationRevision,
    endpointIdentity: request.profile.endpointIdentity,
    protocol: request.profile.protocol,
    modelId: request.modelId,
    compatibility: unknownCapabilities ? "partially-compatible" : "protocol-compatible",
    protocolVerified: observation.protocolVerified,
    modelVerified: observation.modelVerified,
    capabilities,
    contextWindow,
    failure: null,
    checkedAt,
  });
}

function resultForFailure(
  request: BackendCompatibilityProbeRequest,
  failure: BackendProbeError,
  checkedAt: string,
): BackendCompatibilityProbeResult {
  const hints = new Map(request.capabilityHints.map((capability) => [capability.id, capability]));
  const capabilities = MODEL_CAPABILITY_IDS.map((id): BackendProbeCapabilityEvidence => ({
    ...(hints.get(id) ?? unknownCapability(id)),
    checkedAt,
  }));
  return backendCompatibilityProbeResultSchema.parse({
    profileId: request.profile.id,
    backendConfigurationRevision: request.profile.configurationRevision,
    endpointIdentity: request.profile.endpointIdentity,
    protocol: request.profile.protocol,
    modelId: request.modelId,
    compatibility: "unavailable",
    protocolVerified: false,
    modelVerified: false,
    capabilities,
    contextWindow: contextEvidence(request, {
      protocolVerified: false,
      modelVerified: false,
      observedCapabilities: [],
      contextWindowTokens: null,
      contextWindowProvenance: null,
      contextWindowDetail: null,
    }, checkedAt),
    failure: {
      code: failure.code,
      message: FIXED_FAILURE_MESSAGES[failure.code],
      retryAfterSeconds: failure.retryAfterSeconds,
    } satisfies BackendProbeFailure,
    checkedAt,
  });
}

function contextEvidence(
  request: BackendCompatibilityProbeRequest,
  observation: ProbeObservation,
  checkedAt: string,
): BackendProbeContextEvidence {
  if (observation.contextWindowTokens !== null) {
    return {
      tokens: observation.contextWindowTokens,
      state: "verified",
      provenance: observation.contextWindowProvenance ?? "probe",
      detail: observation.contextWindowDetail,
      checkedAt,
    };
  }
  if (request.contextWindowHint) {
    return {
      tokens: request.contextWindowHint.tokens,
      state: request.contextWindowHint.provenance === "user" ? "user-declared" : "partially-compatible",
      provenance: request.contextWindowHint.provenance,
      detail: request.contextWindowHint.detail,
      checkedAt,
    };
  }
  return {
    tokens: null,
    state: "unknown",
    provenance: "unknown",
    detail: null,
    checkedAt,
  };
}
