import type Database from "better-sqlite3";

import {
  providerMetadataScopeKey,
  type PersistedProviderMetadata,
} from "../provider/metadata";
import { parseJsonArray } from "./codecs";
import type { ProviderMetadataCacheRow } from "./rows";

export class ProviderMetadataRepository {
  constructor(private readonly database: Database.Database) {}

  load(): PersistedProviderMetadata[] {
    const rows = this.database.prepare(`
      SELECT *
      FROM provider_metadata_scoped_cache
      ORDER BY provider_id ASC, scope_key ASC
    `).all() as ProviderMetadataCacheRow[];
    return rows.map((row) => ({
      scope: {
        providerId: row.provider_id,
        harnessId: row.harness_id,
        backendProfileId: row.backend_profile_id,
        modelId: row.model_id,
        executable: row.executable,
        version: row.version,
        backendConfigurationRevision: row.backend_configuration_revision,
        authState: row.auth_state,
      },
      models: parseJsonArray(row.models_json),
      modelsUpdatedAt: row.models_updated_at,
      modelsLastAttemptedAt: row.models_last_attempted_at,
      modelsProvenance: row.models_provenance,
      modelsStale: row.models_stale === 1,
      rateLimits: parseJsonArray(row.rate_limits_json),
      rateLimitsUpdatedAt: row.rate_limits_updated_at,
      rateLimitsLastAttemptedAt: row.rate_limits_last_attempted_at,
      rateLimitsProvenance: row.rate_limits_provenance,
      rateLimitsStale: row.rate_limits_stale === 1,
    })) as PersistedProviderMetadata[];
  }

  save(metadata: PersistedProviderMetadata): void {
    const modelsJson = JSON.stringify(metadata.models);
    const rateLimitsJson = JSON.stringify(metadata.rateLimits);
    if (modelsJson.length > 262_144 || rateLimitsJson.length > 65_536) return;
    const scopeKey = providerMetadataScopeKey(metadata.scope);
    this.database.prepare(`
      INSERT INTO provider_metadata_scoped_cache (
        scope_key, provider_id, harness_id, backend_profile_id, model_id,
        executable, version, backend_configuration_revision, auth_state,
        models_json, models_updated_at, models_last_attempted_at, models_provenance, models_stale,
        rate_limits_json, rate_limits_updated_at, rate_limits_last_attempted_at, rate_limits_provenance, rate_limits_stale
      ) VALUES (
        @scopeKey, @providerId, @harnessId, @backendProfileId, @modelId,
        @executable, @version, @backendConfigurationRevision, @authState,
        @modelsJson, @modelsUpdatedAt, @modelsLastAttemptedAt, @modelsProvenance, @modelsStaleValue,
        @rateLimitsJson, @rateLimitsUpdatedAt, @rateLimitsLastAttemptedAt, @rateLimitsProvenance, @rateLimitsStaleValue
      ) ON CONFLICT(scope_key) DO UPDATE SET
        executable = excluded.executable,
        version = excluded.version,
        auth_state = excluded.auth_state,
        models_json = excluded.models_json,
        models_updated_at = excluded.models_updated_at,
        models_last_attempted_at = excluded.models_last_attempted_at,
        models_provenance = excluded.models_provenance,
        models_stale = excluded.models_stale,
        rate_limits_json = excluded.rate_limits_json,
        rate_limits_updated_at = excluded.rate_limits_updated_at,
        rate_limits_last_attempted_at = excluded.rate_limits_last_attempted_at,
        rate_limits_provenance = excluded.rate_limits_provenance,
        rate_limits_stale = excluded.rate_limits_stale
    `).run({
      scopeKey,
      ...metadata.scope,
      ...metadata,
      modelsJson,
      rateLimitsJson,
      modelsStaleValue: metadata.modelsStale ? 1 : 0,
      rateLimitsStaleValue: metadata.rateLimitsStale ? 1 : 0,
    });
  }
}
