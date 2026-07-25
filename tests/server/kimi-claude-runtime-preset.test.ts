import { describe, expect, it } from "vitest";

import {
  createKimiClaudeBackendProfile,
  createKimiClaudeModelSelection,
} from "../../src/shared/claude-backend-profiles";
import type { ProviderInfo } from "../../src/shared/contracts";
import { createKimiClaudeRuntimePreset } from "../../src/server/runtime/backends/kimi-claude-preset";

const SECRET_REFERENCE = "secret:kimi-runtime-preset";
const SECRET_VALUE = "runtime-preset-secret";

function claudeProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  const unavailable = {
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
    version: "2.1.219",
    executable: "/usr/local/bin/claude",
    installState: "installed",
    authState: "unauthenticated",
    canRun: false,
    statusMessage: "Sign in required",
    models: [],
    rateLimits: [],
    metadataState: { models: unavailable, rateLimits: unavailable },
    ...overrides,
  };
}

describe("Kimi Claude runtime preset", () => {
  it("uses backend credential presence instead of native Anthropic auth", async () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:runtime-ready",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
    });
    const preset = createKimiClaudeRuntimePreset({
      profiles: [profile],
      backendCredentials: {
        has: async (reference) => reference === SECRET_REFERENCE,
        resolve: async (reference) => reference === SECRET_REFERENCE ? SECRET_VALUE : null,
      },
    });
    const selection = createKimiClaudeModelSelection({ profile });

    await expect(preset.readiness(selection, claudeProvider())).resolves.toEqual({
      ready: true,
      message: null,
    });
  });

  it("fails readiness without the selected profile credential", async () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:runtime-missing-secret",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
    });
    const preset = createKimiClaudeRuntimePreset({
      profiles: [profile],
      backendCredentials: {
        has: async () => false,
        resolve: async () => null,
      },
    });

    await expect(preset.readiness(
      createKimiClaudeModelSelection({ profile }),
      claudeProvider(),
    )).resolves.toEqual({
      ready: false,
      message: "The Kimi credential is unavailable.",
    });
  });

  it("keeps safe registrations separate from privileged launch resolution", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:runtime-registration",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
    });
    const preset = createKimiClaudeRuntimePreset({
      profiles: [profile],
      backendCredentials: {
        has: async () => true,
        resolve: async () => SECRET_VALUE,
      },
    });

    expect(JSON.stringify(preset.providerManagerOptions.backendProfiles)).not.toContain(
      SECRET_REFERENCE,
    );
    expect(JSON.stringify(preset.providerManagerOptions.backendProfiles)).not.toContain(
      SECRET_VALUE,
    );
    expect(preset.providerManagerOptions.backendCompatibilities).toEqual([
      expect.objectContaining({
        harnessId: "claude-agent-sdk",
        backendProfileId: profile.id,
        state: "partially-compatible",
      }),
    ]);
  });
});
