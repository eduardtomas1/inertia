import { modelSelectionSchema, versionedContinuationIdentitySchema } from "../model-routing";
import { isContinuationReasonCode, isTurnSessionRecovery } from "../continuation-policy";
import { modelBackendDefaultSchema, modelBackendProfileDetailSchema, modelBackendProfileViewSchema } from "../backend-profile-settings";

type UnknownRecord = Record<string, unknown>;

export function modelSelection(value: unknown): boolean {
  return modelSelectionSchema.safeParse(value).success;
}
export function continuationIdentity(value: unknown): boolean {
  return versionedContinuationIdentitySchema.safeParse(value).success;
}
export function optionalContinuationReasonCode(value: UnknownRecord): boolean {
  const reason = value.continuationReasonCode;
  const recovery = value.sessionRecovery;
  return (reason === undefined || reason === null || isContinuationReasonCode(reason)) && (recovery === undefined || recovery === null || isTurnSessionRecovery(recovery));
}
export function backendProfile(value: unknown, detail = false): boolean {
  return (detail ? modelBackendProfileDetailSchema : modelBackendProfileViewSchema)
    .safeParse(value).success;
}

export function backendDefault(value: unknown): boolean {
  return modelBackendDefaultSchema.safeParse(value).success;
}
