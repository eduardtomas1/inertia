import { join } from "node:path";

import { RuntimeStore } from "../../../src/server/database";
import { backendEndpointIdentity } from "../../../src/shared/backend-endpoint-identity";
import {
  backendCompatibilityProbeResultSchema,
} from "../../../src/shared/backend-probe";
import {
  persistedModelBackendProfileSchema,
} from "../../../src/shared/backend-profile-settings";
import { MODEL_CAPABILITY_IDS } from "../../../src/shared/model-routing";
import { backendProbeTestAuthority } from "../../helpers/backend-probe-authority";

export function seedLargeModelCatalog(
  testDirectory: string,
  workspaceDirectory: string,
): void {
  const store = new RuntimeStore(
    join(testDirectory, "data", "inertia.sqlite"),
    workspaceDirectory,
    { recoverInterruptedRuns: false },
  );
  const cachedAt = new Date().toISOString();
  try {
    for (let profileIndex = 0; profileIndex < 5; profileIndex += 1) {
      const models = Array.from({ length: 120 }, (_, modelIndex) => {
        const index = (profileIndex * 120) + modelIndex;
        const suffix = String(index).padStart(4, "0");
        return {
          id: `catalog-${suffix}`,
          displayName: `Catalog Model ${suffix}`,
          contextWindowTokens: null,
          reasoningOptions: [],
          capabilities: [],
        };
      });
      const baseUrl = `https://catalog-${profileIndex}.example.test/v1`;
      const profile = persistedModelBackendProfileSchema.parse({
        id: `custom:catalog-${profileIndex}`,
        displayName: `Catalog gateway ${profileIndex + 1}`,
        harnessId: "codex-app-server",
        protocol: "openai-responses",
        authenticationMode: "none",
        source: "custom",
        enabled: true,
        configurationRevision: 1,
        endpointIdentity: backendEndpointIdentity(baseUrl),
        preset: "custom",
        baseUrl,
        allowInsecureLocalhost: false,
        credentialGeneration: null,
        models,
        routing: { mode: "simple", primaryModelId: models[0]!.id },
        capabilityHints: [],
        createdAt: cachedAt,
        updatedAt: cachedAt,
      });
      store.saveModelBackendProfile(profile);
      // Keep both ends of the large catalog selectable with exact per-model
      // evidence; intermediate entries still exercise unverified-model rows.
      for (const model of [models[0]!, models.at(-1)!]) {
        store.recordModelBackendProbe(
          profile.id,
          backendCompatibilityProbeResultSchema.parse({
            profileId: profile.id,
            backendConfigurationRevision: profile.configurationRevision,
            endpointIdentity: profile.endpointIdentity,
            protocol: profile.protocol,
            modelId: model.id,
            compatibility: "protocol-compatible",
            protocolVerified: true,
            modelVerified: true,
            capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
              id,
              state: (id === "streaming" || id === "tools") ? "verified" : "unknown",
              provenance: (id === "streaming" || id === "tools") ? "probe" : "unknown",
              detail: null,
              checkedAt: cachedAt,
            })),
            contextWindow: {
              tokens: null,
              state: "unknown",
              provenance: "unknown",
              detail: null,
              checkedAt: cachedAt,
            },
            failure: null,
            checkedAt: cachedAt,
            authority: backendProbeTestAuthority(cachedAt, profileIndex + 1),
          }),
        );
      }
    }
  } finally {
    store.close();
  }
}
