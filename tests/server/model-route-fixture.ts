import {
  legacyProviderIdForHarness,
  type HarnessBackendCompatibility,
  type KnownHarnessId,
  type ModelBackendProfile,
  type ModelSelection,
  nativeBackendProfile,
  nativeHarnessId,
  nativeModelSelection,
  resolveHarnessBackendCompatibility,
  versionedContinuationIdentityForSelection,
} from "../../src/shared/model-routing";
import type {
  ProviderAccessMode,
  ProviderId,
  ProviderInteractionMode,
  ProviderRunInput,
} from "../../src/server/provider/contracts";
import type { ProviderSkillInput } from "../../src/shared/contracts";

const TEST_PROVIDER_COMPATIBILITY_TOKEN = "a".repeat(64);

interface NativeProviderRunInput {
  providerId: ProviderId;
  harnessId?: KnownHarnessId;
  conversationId: string;
  runId?: string;
  turnId?: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  interactionMode: ProviderInteractionMode;
  access: ProviderAccessMode;
  sessionId?: string;
  imagePaths?: readonly string[];
  skills?: readonly ProviderSkillInput[];
  goalStart?: ProviderRunInput["goalStart"];
  goalContinuationExpected?: boolean;
}

export function nativeProviderRunFields(
  providerId: ProviderId,
  modelId = "provider-default",
  reasoningEffort = "",
  harnessOverride?: KnownHarnessId,
): Pick<
  ProviderRunInput,
  | "providerId"
  | "harnessId"
  | "backendProfile"
  | "backendCompatibility"
  | "modelSelection"
  | "continuationIdentity"
  | "model"
  | "reasoningEffort"
> {
  const harnessId = harnessOverride ?? nativeHarnessId(providerId);
  const backendProfile = nativeBackendProfile(providerId);
  const modelSelection = {
    ...nativeModelSelection({
      providerId,
      modelId,
      reasoningEffort,
    }),
    harnessId,
  };
  const backendCompatibility = resolveHarnessBackendCompatibility(
    harnessId,
    backendProfile,
  );
  return {
    providerId,
    harnessId,
    backendProfile,
    backendCompatibility,
    modelSelection,
    continuationIdentity: versionedContinuationIdentityForSelection(
      modelSelection,
      backendProfile.endpointIdentity,
      !backendCompatibility.allowsModelSwitchWithinSession,
      TEST_PROVIDER_COMPATIBILITY_TOKEN,
    ),
    model: modelId === "provider-default" ? undefined : modelId,
    reasoningEffort: reasoningEffort || undefined,
  };
}

export function resolveNativeModelRoute(selection: ModelSelection): {
  providerId: ProviderId;
  harnessId: KnownHarnessId;
  backendProfile: ModelBackendProfile;
  compatibility: HarnessBackendCompatibility;
  continuationIdentity: ReturnType<typeof versionedContinuationIdentityForSelection>;
} {
  const providerId = legacyProviderIdForHarness(selection.harnessId);
  if (!providerId) throw new Error(`Unknown test harness '${selection.harnessId}'.`);
  const harnessId = selection.harnessId as KnownHarnessId;
  const backendProfile = nativeBackendProfile(providerId);
  const compatibility = resolveHarnessBackendCompatibility(harnessId, backendProfile);
  return {
    providerId,
    harnessId,
    backendProfile,
    compatibility,
    continuationIdentity: versionedContinuationIdentityForSelection(
      selection,
      backendProfile.endpointIdentity,
      !compatibility.allowsModelSwitchWithinSession,
      TEST_PROVIDER_COMPATIBILITY_TOKEN,
    ),
  };
}

export function nativeProviderRunInput(
  input: NativeProviderRunInput,
): ProviderRunInput {
  return {
    ...nativeProviderRunFields(
      input.providerId,
      input.model ?? "provider-default",
      input.reasoningEffort ?? "",
      input.harnessId,
    ),
    ...input,
    // Explicit test-only allocation for direct harness consumers. Production
    // callers must allocate and persist their own authoritative identities.
    runId: input.runId ?? `run-${input.conversationId}`,
    turnId: input.turnId ?? `turn-${input.conversationId}`,
  };
}
