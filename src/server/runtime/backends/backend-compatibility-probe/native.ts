import {
  MODEL_CAPABILITY_IDS,
  modelCapabilitySchema,
  type ModelCapability,
  type ModelCapabilityId,
} from "../../../../shared/model-routing";
import {
  abortable,
  BackendProbeError,
  boundedDetail,
  FIXED_FAILURE_MESSAGES,
  plainObject,
  throwIfAborted,
  validContextProvenance,
  type BackendCompatibilityProbeDependencies,
  type NativeBackendProbeAdapter,
  type ProbeObservation,
} from "./core";
import type { BackendCompatibilityProbeRequest } from "../../../../shared/backend-probe";

const MAX_NATIVE_MODELS = 512;
const MAX_NATIVE_CAPABILITIES = MODEL_CAPABILITY_IDS.length;

export async function probeNativeBackend(
  request: BackendCompatibilityProbeRequest,
  dependencies: BackendCompatibilityProbeDependencies,
  signal: AbortSignal,
): Promise<ProbeObservation> {
  const protocol = request.profile.protocol;
  if (protocol !== "cursor-managed" && protocol !== "kimi-managed" && protocol !== "opencode-native") {
    throw new BackendProbeError("unsupported-protocol", FIXED_FAILURE_MESSAGES["unsupported-protocol"]);
  }
  const adapter = dependencies.nativeAdapters?.[protocol];
  if (!adapter) {
    throw new BackendProbeError("unsupported-protocol", FIXED_FAILURE_MESSAGES["unsupported-protocol"]);
  }
  const observed: unknown = await abortable(adapter.probe({
    profileId: request.profile.id,
    protocol,
    modelId: request.modelId,
  }, signal), signal);
  throwIfAborted(signal);
  if (
    !plainObject(observed)
    || typeof observed.protocolVerified !== "boolean"
    || typeof observed.modelVerified !== "boolean"
  ) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  if (!observed.protocolVerified) {
    throw new BackendProbeError("unsupported-protocol", FIXED_FAILURE_MESSAGES["unsupported-protocol"]);
  }
  if (!observed.modelVerified) {
    throw new BackendProbeError("missing-model", FIXED_FAILURE_MESSAGES["missing-model"]);
  }
  const capabilities = validateNativeCapabilities(
    observed.capabilities === undefined ? [] : observed.capabilities,
  );
  if (
    observed.contextWindowTokens !== undefined
    && observed.contextWindowTokens !== null
    && typeof observed.contextWindowTokens !== "number"
  ) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  const contextWindowTokens = typeof observed.contextWindowTokens === "number"
    ? observed.contextWindowTokens
    : null;
  if (
    contextWindowTokens !== null
    && (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0 || contextWindowTokens > 100_000_000)
  ) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  return {
    protocolVerified: true,
    modelVerified: true,
    observedCapabilities: capabilities,
    contextWindowTokens,
    contextWindowProvenance: contextWindowTokens === null
      ? null
      : validContextProvenance(observed.contextWindowProvenance),
    contextWindowDetail: boundedDetail(
      typeof observed.contextWindowDetail === "string" ? observed.contextWindowDetail : null,
    ),
  };
}

function validateNativeCapabilities(capabilities: unknown): readonly ModelCapability[] {
  if (!Array.isArray(capabilities)) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  if (capabilities.length > MAX_NATIVE_CAPABILITIES) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  const ids = new Set<ModelCapabilityId>();
  return capabilities.map((input) => {
    const parsed = modelCapabilitySchema.safeParse(input);
    if (!parsed.success) {
      throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
    }
    const capability = parsed.data;
    if (ids.has(capability.id) || capability.provenance === "probe") {
      throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
    }
    ids.add(capability.id);
    return capability;
  });
}

/**
 * Adapter for authoritative native model catalogs (OpenCode provider.list,
 * Cursor ACP model config options). Catalog loading remains owned by the
 * native harness; this adapter only validates and projects bounded evidence.
 */
export function nativeModelCatalogProbeAdapter(
  loadModels: (
    signal: AbortSignal,
  ) => Promise<readonly {
    id: string;
    capabilities?: readonly ModelCapability[];
    contextWindowTokens?: number | null;
  }[]>,
): NativeBackendProbeAdapter {
  return {
    async probe(input, signal) {
      const models = await abortable(loadModels(signal), signal);
      throwIfAborted(signal);
      if (!Array.isArray(models)) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      if (models.length > MAX_NATIVE_MODELS) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      const selected = models.find((model) => (
        plainObject(model) && model.id === input.modelId
      ));
      if (!selected) {
        return { protocolVerified: true, modelVerified: false };
      }
      if (
        !plainObject(selected)
        || typeof selected.id !== "string"
        || selected.id.length === 0
        || selected.id.length > 500
        || /[\0\r\n]/u.test(selected.id)
      ) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      if (
        selected.contextWindowTokens !== undefined
        && selected.contextWindowTokens !== null
        && typeof selected.contextWindowTokens !== "number"
      ) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      return {
        protocolVerified: true,
        modelVerified: true,
        capabilities: validateNativeCapabilities(selected.capabilities ?? []),
        contextWindowTokens: typeof selected.contextWindowTokens === "number"
          ? selected.contextWindowTokens
          : null,
        contextWindowProvenance: selected.contextWindowTokens == null ? null : "provider",
      };
    },
  };
}
