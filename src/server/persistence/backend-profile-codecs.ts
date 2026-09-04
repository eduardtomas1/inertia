import {
  containsBackendCredentialMaterial,
  persistedModelBackendProfileSchema,
} from "../../shared/backend-profile-settings";
import {
  backendCompatibilityProbeResultCollectionSchema,
  backendCompatibilityProbeResultSchema,
  type BackendCompatibilityProbeResult,
  type BackendProbeAdmissionHighWater,
} from "../../shared/backend-probe";
import type { ModelBackendProfileRow } from "./rows";
import type { StoredModelBackendProfile } from "./types";
import { backendEndpointIdentityMatches } from "../../shared/backend-endpoint-identity";

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
    profile.source === "custom"
    && !backendEndpointIdentityMatches(profile.baseUrl, profile.endpointIdentity)
  ) {
    throw new Error(
      "The stored custom backend endpoint does not match its immutable identity.",
    );
  }
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
  const { probeResults, probeAdmissionHighWater } = parseProbeState(probeValue);
  if (probeResults.some((result) => (
    result.profileId !== profile.id
    || result.backendConfigurationRevision !== profile.configurationRevision
    || result.endpointIdentity !== profile.endpointIdentity
    || result.protocol !== profile.protocol
    || !profile.models.some(({ id }) => id === result.modelId)
  ))) {
    throw new Error(
      "The stored backend probe evidence does not match its profile revision.",
    );
  }
  if (probeAdmissionHighWater.some(({ modelId }) =>
    !profile.models.some(({ id }) => id === modelId))) {
    throw new Error(
      "The stored backend probe admission state does not match its profile revision.",
    );
  }
  const latestProbe = probeResults.reduce<BackendCompatibilityProbeResult | null>(
    (latest, candidate) => latest === null
      || Date.parse(candidate.checkedAt) > Date.parse(latest.checkedAt)
      ? candidate
      : latest,
    null,
  );
  return { profile, probeResults, probeAdmissionHighWater, latestProbe };
}

function parseProbeState(value: unknown): {
  probeResults: readonly BackendCompatibilityProbeResult[];
  probeAdmissionHighWater: readonly BackendProbeAdmissionHighWater[];
} {
  if (value === null) {
    return { probeResults: [], probeAdmissionHighWater: [] };
  }
  // Migration compatibility: releases before the per-model cache stored one
  // strict probe result directly in latest_probe_json.
  const legacy = backendCompatibilityProbeResultSchema.safeParse(value);
  if (legacy.success) {
    return {
      probeResults: [legacy.data],
      probeAdmissionHighWater: legacy.data.authority
        ? [{
            modelId: legacy.data.modelId,
            admissionSequence: legacy.data.authority.admissionSequence,
          }]
        : [],
    };
  }
  const collection = backendCompatibilityProbeResultCollectionSchema.parse(value);
  const highWater = new Map(
    (collection.admissionHighWater ?? []).map((entry) => [
      entry.modelId,
      entry.admissionSequence,
    ]),
  );
  // The optional-field migration derives authority from retained results. The
  // next write persists the complete compact map.
  for (const result of collection.results) {
    const sequence = result.authority?.admissionSequence;
    if (sequence !== undefined && sequence > (highWater.get(result.modelId) ?? 0)) {
      highWater.set(result.modelId, sequence);
    }
  }
  return {
    probeResults: collection.results,
    probeAdmissionHighWater: [...highWater]
      .map(([modelId, admissionSequence]) => ({ modelId, admissionSequence }))
      .sort((left, right) => left.modelId.localeCompare(right.modelId)),
  };
}
