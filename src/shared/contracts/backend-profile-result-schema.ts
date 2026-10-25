import {
  backendProfileModelsResultSchema,
  backendProfileProbeSkippedModelIdsSchema,
  modelBackendDefaultSchema,
  modelBackendProfileDetailSchema,
  modelBackendProfileViewSchema,
} from "../backend-profile-settings";
import { PROVIDER_ACCOUNT_KINDS } from "../provider";
import { TURN_FAILURE_KINDS } from "../turn-lifecycle";

type UnknownRecord = Record<string, unknown>;

export function backendProfile(value: unknown, detail = false): boolean {
  return (detail ? modelBackendProfileDetailSchema : modelBackendProfileViewSchema)
    .safeParse(value).success;
}

export function backendDefault(value: unknown): boolean {
  return modelBackendDefaultSchema.safeParse(value).success;
}

export function optionalTurnFailureKind(value: UnknownRecord): boolean {
  return optionalMember(value.failureKind, TURN_FAILURE_KINDS);
}

export function optionalProviderAccountKind(value: UnknownRecord): boolean {
  return optionalMember(value.accountKind, PROVIDER_ACCOUNT_KINDS);
}

export const backendProfileResultValidators = {
  "backend.profile": (value: UnknownRecord) =>
    backendProfile(value.profile, true)
    && (value.credentialCleared === undefined || value.credentialCleared === true),
  "backend.profile.probe": (value: UnknownRecord) =>
    backendProfile(value.profile, true)
    && (value.skippedModelIds === undefined
      || backendProfileProbeSkippedModelIdsSchema.safeParse(value.skippedModelIds).success),
  "backend.profile.models": (value: UnknownRecord) =>
    backendProfileModelsResultSchema.safeParse(value).success,
  "backend.default": (value: UnknownRecord) =>
    value.value === null || backendDefault(value.value),
};

function optionalMember(value: unknown, options: readonly string[]): boolean {
  return value === undefined || (typeof value === "string" && options.includes(value));
}
