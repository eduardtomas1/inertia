import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { backendEndpointIdentity } from "../../src/shared/backend-endpoint-identity";
import {
  modelSelectionForBackendProfile,
  persistedModelBackendProfileSchema,
} from "../../src/shared/backend-profile-settings";
import type { ModelSelection, ProviderInfo } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import { BackendProfileController } from "../../src/server/runtime/backends/backend-profile-controller";
import { watcherRouteReadiness } from "../../src/server/runtime/watcher/watcher-route";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";

const MESSAGE = "Claude Code 2.1.150 is installed. Inertia needs 2.1.309 or newer because older versions ignore the restrictions Inertia sets and can write outside the project. Update Claude Code and refresh.";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

function outdatedClaude(): ProviderInfo {
  const metadata = {
    freshness: "unavailable" as const,
    provenance: null,
    updatedAt: null,
    lastAttemptedAt: null,
    refreshing: false,
  };
  return {
    id: "claude",
    label: "Claude",
    command: "claude",
    available: true,
    version: "2.1.150",
    executable: "/opt/bin/claude",
    installState: "installed",
    authState: "unknown",
    canRun: false,
    updateRequired: { installedVersion: "2.1.150", minimumVersion: "2.1.309" },
    statusMessage: MESSAGE,
    models: [],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

function apiKeyProfile() {
  const timestamp = "2026-10-26T08:00:00.000Z";
  return persistedModelBackendProfileSchema.parse({
    id: "custom:watcher-floor",
    displayName: "Anthropic API key",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 1,
    endpointIdentity: backendEndpointIdentity("https://gateway.example.test/v1"),
    preset: "custom",
    baseUrl: "https://gateway.example.test/v1",
    allowInsecureLocalhost: false,
    credentialGeneration: "generation:watcher",
    models: [{
      id: "watcher-model",
      displayName: "Watcher model",
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: "watcher-model" },
    capabilityHints: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

describe("watcher route readiness", () => {
  it("refuses an API-key watcher on a Claude Code below Inertia's minimum version with the discovery reason", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-watcher-floor-"));
    directories.push(directory);
    const store = new RuntimeStore(join(directory, "runtime.sqlite"), directory);
    try {
      const profile = store.saveModelBackendProfile(apiKeyProfile()).profile;
      const backendProfiles = BackendProfileController.open({ store });
      await expect(watcherRouteReadiness({
        backendProfiles,
        providers: {
          resolveModelRoute: (selection: ModelSelection) => ({
            providerId: "claude",
            harnessId: selection.harnessId,
          }) as ReturnType<TurnProviderRuntime["resolveModelRoute"]>,
        },
        providerInfo: () => [outdatedClaude()],
      }, modelSelectionForBackendProfile(profile, "watcher-model"))).resolves.toEqual({ ready: false, message: MESSAGE });
    } finally {
      store.close();
    }
  });
});
