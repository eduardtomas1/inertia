import {
  containsBackendCredentialMaterial,
  persistedModelBackendProfileSchema,
} from "../../shared/backend-profile-settings";
import { backendCompatibilityProbeResultSchema } from "../../shared/backend-probe";
import type { ModelBackendProfileRow } from "./rows";
import type { StoredModelBackendProfile } from "./types";

export function modelBackendProfileFromRow(
  row: ModelBackendProfileRow,
): StoredModelBackendProfile {
  let profileValue: unknown;
  let probeValue: unknown = null;
  try {
    profileValue = JSON.parse(row.configuration_json) as unknown;
    if (row.latest_probe_json !== null) {
      probeValue = JSON.parse(row.latest_probe_json) as unknown;
    }
  } catch {
    throw new Error("The stored model backend profile is invalid.");
  }
  if (containsBackendCredentialMaterial(profileValue)) {
    throw new Error(
      "The stored model backend profile contains credential material.",
    );
  }
  const profile = persistedModelBackendProfileSchema.parse(profileValue);
  if (
    profile.id !== row.profile_id
    || profile.harnessId !== row.harness_id
    || profile.preset !== row.preset
    || profile.protocol !== row.protocol
    || profile.source !== row.source
    || profile.enabled !== (row.enabled === 1)
    || profile.configurationRevision !== row.configuration_revision
    || profile.endpointIdentity !== row.endpoint_identity
    || profile.credentialGeneration !== row.credential_generation
    || profile.createdAt !== row.created_at
    || profile.updatedAt !== row.updated_at
  ) {
    throw new Error(
      "The stored model backend profile columns do not match its configuration.",
    );
  }
  const latestProbe = probeValue === null
    ? null
    : backendCompatibilityProbeResultSchema.parse(probeValue);
  return { profile, latestProbe };
}
