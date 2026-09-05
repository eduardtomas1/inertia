import type { ModelSelection } from "../../shared/contracts";
import {
  containsBackendCredentialMaterial,
  modelBackendDefaultSchema,
  persistedModelBackendProfileSchema,
  type ModelBackendDefault,
  type PersistedModelBackendProfile,
} from "../../shared/backend-profile-settings";
import {
  MAX_BACKEND_PROBE_RESULTS_PER_PROFILE,
  backendCompatibilityProbeResultCollectionSchema,
  backendCompatibilityProbeResultSchema,
  type BackendCompatibilityProbeResult,
  type BackendProbeAdmissionHighWater,
} from "../../shared/backend-probe";
import { modelSelectionSchema } from "../../shared/model-routing";
import { modelBackendProfileFromRow } from "./backend-profile-codecs";
import type { PersistenceContext } from "./context";
import { RecordNotFoundError } from "./errors";
import type {
  ModelBackendDefaultRow,
  ModelBackendProfileRow,
} from "./rows";
import type { StoredModelBackendProfile } from "./types";
import { backendEndpointIdentityMatches } from "../../shared/backend-endpoint-identity";

type BackendProfilePersistenceContext = Pick<PersistenceContext, "database" | "requireProject">;

const MAX_PROBE_RESULT_JSON_BYTES = 262_144;

export class BackendProfileRepository {
  constructor(private readonly context: BackendProfilePersistenceContext) {}

  listProfiles(): StoredModelBackendProfile[] {
    return (this.context.database.prepare(`
      SELECT * FROM model_backend_profiles
      ORDER BY created_at ASC, profile_id ASC
    `).all() as ModelBackendProfileRow[]).map(modelBackendProfileFromRow);
  }

  profile(profileId: string): StoredModelBackendProfile {
    const row = this.context.database.prepare(`
      SELECT * FROM model_backend_profiles WHERE profile_id = ?
    `).get(profileId) as ModelBackendProfileRow | undefined;
    if (!row) throw new RecordNotFoundError("Model backend profile not found.");
    return modelBackendProfileFromRow(row);
  }

  saveProfile(profileInput: PersistedModelBackendProfile): StoredModelBackendProfile {
    const parsed = persistedModelBackendProfileSchema.parse(profileInput);
    if (
      parsed.source === "custom"
      && !backendEndpointIdentityMatches(parsed.baseUrl, parsed.endpointIdentity)
    ) {
      throw new Error(
        "The custom backend endpoint does not match its immutable identity.",
      );
    }
    const existing = this.context.database.prepare(`
      SELECT * FROM model_backend_profiles WHERE profile_id = ?
    `).get(parsed.id) as ModelBackendProfileRow | undefined;
    const profile = existing
      ? persistedModelBackendProfileSchema.parse({
          ...parsed,
          createdAt: existing.created_at,
        })
      : parsed;
    if (containsBackendCredentialMaterial(profile)) {
      throw new Error("Model backend profiles cannot contain credential material.");
    }
    const configurationJson = JSON.stringify(profile);
    if (Buffer.byteLength(configurationJson, "utf8") > 262_144) {
      throw new Error("The model backend profile is too large.");
    }
    if (existing && existing.source === "built-in" && profile.source === "custom") {
      throw new Error("Built-in model backend identities cannot be replaced.");
    }
    const invalidatesEvidence = Boolean(existing && (
      existing.configuration_revision !== profile.configurationRevision
      || existing.endpoint_identity !== profile.endpointIdentity
      || existing.protocol !== profile.protocol
    ));
    this.context.database.transaction(() => {
      this.context.database.prepare(`
        INSERT INTO model_backend_profiles (
          profile_id, harness_id, preset, protocol, source, enabled,
          configuration_revision, endpoint_identity, credential_generation,
          configuration_json, latest_probe_json, created_at, updated_at
        ) VALUES (
          @profileId, @harnessId, @preset, @protocol, @source, @enabled,
          @configurationRevision, @endpointIdentity, @credentialGeneration,
          @configurationJson, NULL, @createdAt, @updatedAt
        )
        ON CONFLICT(profile_id) DO UPDATE SET
          harness_id = excluded.harness_id,
          preset = excluded.preset,
          protocol = excluded.protocol,
          source = excluded.source,
          enabled = excluded.enabled,
          configuration_revision = excluded.configuration_revision,
          endpoint_identity = excluded.endpoint_identity,
          credential_generation = excluded.credential_generation,
          configuration_json = excluded.configuration_json,
          latest_probe_json = CASE
            WHEN model_backend_profiles.configuration_revision
                   <> excluded.configuration_revision
              OR model_backend_profiles.endpoint_identity
                   IS NOT excluded.endpoint_identity
              OR model_backend_profiles.protocol <> excluded.protocol
              THEN NULL
            ELSE model_backend_profiles.latest_probe_json
          END,
          updated_at = excluded.updated_at
      `).run({
        profileId: profile.id,
        harnessId: profile.harnessId,
        preset: profile.preset,
        protocol: profile.protocol,
        source: profile.source,
        enabled: Number(profile.enabled),
        configurationRevision: profile.configurationRevision,
        endpointIdentity: profile.endpointIdentity,
        credentialGeneration: profile.credentialGeneration,
        configurationJson,
        createdAt: existing?.created_at ?? profile.createdAt,
        updatedAt: profile.updatedAt,
      });
      if (invalidatesEvidence) this.clearDefaultsForProfile(profile.id);
    })();
    return this.profile(profile.id);
  }

  reconcileCredentialGeneration(
    profileId: string,
    credentialGeneration: string | null,
  ): StoredModelBackendProfile {
    const stored = this.profile(profileId);
    if (stored.profile.credentialGeneration === credentialGeneration) return stored;
    const now = new Date().toISOString();
    const next = persistedModelBackendProfileSchema.parse({
      ...stored.profile,
      enabled: false,
      credentialGeneration,
      configurationRevision: stored.profile.configurationRevision + 1,
      updatedAt: now,
    });
    return this.saveProfile(next);
  }

  recordProbe(
    profileId: string,
    resultInput: BackendCompatibilityProbeResult,
  ): StoredModelBackendProfile {
    const result = backendCompatibilityProbeResultSchema.parse(resultInput);
    const authority = result.authority;
    if (!authority) {
      throw new Error("Backend probe evidence lacks exact admission authority.");
    }
    const persistIfNewest = this.context.database.transaction(() => {
      const stored = this.profile(profileId);
      if (
        result.profileId !== stored.profile.id
        || result.backendConfigurationRevision
          !== stored.profile.configurationRevision
        || result.endpointIdentity !== stored.profile.endpointIdentity
        || result.protocol !== stored.profile.protocol
      ) {
        throw new Error("The backend probe result does not match this profile revision.");
      }
      if (!stored.profile.models.some(({ id }) => id === result.modelId)) {
        throw new Error("The backend probe result model is not configured on this profile.");
      }

      // The controller allocates this sequence synchronously at admission,
      // before probe I/O. BEGIN IMMEDIATE makes the exact-model compare/write
      // one serialized durable transition without trusting wall-clock order.
      const previousAdmissionSequence = stored.probeAdmissionHighWater.find(
        (entry) => entry.modelId === result.modelId,
      )?.admissionSequence ?? 0;
      if (previousAdmissionSequence >= authority.admissionSequence) {
        return stored;
      }

      const admissionHighWater = [
        { modelId: result.modelId, admissionSequence: authority.admissionSequence },
        ...stored.probeAdmissionHighWater.filter(
          ({ modelId }) => modelId !== result.modelId,
        ),
      ].sort((left, right) => left.modelId.localeCompare(right.modelId));
      const results = [
        result,
        ...stored.probeResults.filter(({ modelId }) => modelId !== result.modelId),
      ].sort(compareProbeRecency);
      trimProbeResults(results, result.modelId);
      let resultJson = serializeProbeResults(results, admissionHighWater);
      while (
        Buffer.byteLength(resultJson, "utf8") > MAX_PROBE_RESULT_JSON_BYTES
        && removeOldestOtherModel(results, result.modelId)
      ) {
        resultJson = serializeProbeResults(results, admissionHighWater);
      }
      if (Buffer.byteLength(resultJson, "utf8") > MAX_PROBE_RESULT_JSON_BYTES) {
        throw new Error("The backend probe result is too large.");
      }

      const update = this.context.database.prepare(`
        UPDATE model_backend_profiles
        SET latest_probe_json = ?
        WHERE profile_id = ?
          AND configuration_revision = ?
          AND endpoint_identity IS ?
          AND protocol = ?
      `).run(
        resultJson,
        profileId,
        result.backendConfigurationRevision,
        result.endpointIdentity,
        result.protocol,
      );
      if (update.changes !== 1) {
        throw new Error("The backend profile changed while recording probe evidence.");
      }
      return this.profile(profileId);
    });
    return persistIfNewest.immediate();
  }

  deleteProfile(profileId: string): void {
    const stored = this.profile(profileId);
    if (stored.profile.source === "built-in") {
      throw new Error("Built-in model backend profiles cannot be deleted.");
    }
    this.context.database.transaction(() => {
      this.clearDefaultsForProfile(profileId);
      this.context.database.prepare(
        "DELETE FROM model_backend_profiles WHERE profile_id = ?",
      ).run(profileId);
    })();
  }

  listDefaults(): ModelBackendDefault[] {
    return (this.context.database.prepare(`
      SELECT * FROM model_backend_defaults
      ORDER BY CASE scope WHEN 'global' THEN 0 ELSE 1 END, project_id ASC
    `).all() as ModelBackendDefaultRow[]).map((row) =>
      modelBackendDefaultSchema.parse({
        scope: row.scope,
        projectId: row.project_id,
        selection: JSON.parse(row.selection_json) as unknown,
        updatedAt: row.updated_at,
      }));
  }

  saveDefault(
    projectId: string | null,
    selectionInput: ModelSelection,
  ): ModelBackendDefault {
    if (projectId !== null) this.context.requireProject(projectId);
    const selection = modelSelectionSchema.parse(selectionInput);
    const value = modelBackendDefaultSchema.parse({
      scope: projectId === null ? "global" : "project",
      projectId,
      selection,
      updatedAt: new Date().toISOString(),
    });
    this.context.database.transaction(() => {
      if (projectId === null) {
        this.context.database.prepare(
          "DELETE FROM model_backend_defaults WHERE scope = 'global'",
        ).run();
      } else {
        this.context.database.prepare(`
          DELETE FROM model_backend_defaults
          WHERE scope = 'project' AND project_id = ?
        `).run(projectId);
      }
      this.context.database.prepare(`
        INSERT INTO model_backend_defaults (
          scope, project_id, selection_json, updated_at
        ) VALUES (?, ?, ?, ?)
      `).run(
        value.scope,
        value.projectId,
        JSON.stringify(value.selection),
        value.updatedAt,
      );
    })();
    return value;
  }

  clearDefault(projectId: string | null): void {
    if (projectId === null) {
      this.context.database.prepare(
        "DELETE FROM model_backend_defaults WHERE scope = 'global'",
      ).run();
      return;
    }
    this.context.database.prepare(`
      DELETE FROM model_backend_defaults
      WHERE scope = 'project' AND project_id = ?
    `).run(projectId);
  }

  private clearDefaultsForProfile(profileId: string): void {
    const rows = this.context.database.prepare(`
      SELECT rowid AS row_id, selection_json
      FROM model_backend_defaults
    `).all() as Array<{ row_id: number; selection_json: string }>;
    const remove = this.context.database.prepare(
      "DELETE FROM model_backend_defaults WHERE rowid = ?",
    );
    for (const row of rows) {
      try {
        const selection = modelSelectionSchema.parse(
          JSON.parse(row.selection_json) as unknown,
        );
        if (selection.backendProfileId === profileId) remove.run(row.row_id);
      } catch {
        // Invalid defaults fail closed and cannot remain eligible.
        remove.run(row.row_id);
      }
    }
  }
}

function compareProbeRecency(
  left: BackendCompatibilityProbeResult,
  right: BackendCompatibilityProbeResult,
): number {
  const timeDifference = Date.parse(right.checkedAt) - Date.parse(left.checkedAt);
  return timeDifference || left.modelId.localeCompare(right.modelId);
}

function trimProbeResults(
  results: BackendCompatibilityProbeResult[],
  preservedModelId: string,
): void {
  while (results.length > MAX_BACKEND_PROBE_RESULTS_PER_PROFILE) {
    if (!removeOldestOtherModel(results, preservedModelId)) break;
  }
}

function removeOldestOtherModel(
  results: BackendCompatibilityProbeResult[],
  preservedModelId: string,
): boolean {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (results[index]!.modelId === preservedModelId) continue;
    results.splice(index, 1);
    return true;
  }
  return false;
}

function serializeProbeResults(
  results: readonly BackendCompatibilityProbeResult[],
  admissionHighWater: readonly BackendProbeAdmissionHighWater[],
): string {
  return JSON.stringify(backendCompatibilityProbeResultCollectionSchema.parse({
    schemaVersion: 1,
    results,
    admissionHighWater,
  }));
}
