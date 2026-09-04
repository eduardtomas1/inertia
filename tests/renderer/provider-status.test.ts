import { describe, expect, it } from "vitest";

import { providerSetupAction, providerStateLabel } from "../../src/renderer/src/utils/providerStatus";
import type { ProviderInfo } from "../../src/shared/contracts";

describe("provider compatibility status", () => {
  it("offers refresh instead of sign-in when an authenticated Codex CLI needs an update", () => {
    const provider: ProviderInfo = {
      id: "codex",
      label: "Codex",
      command: "codex",
      available: true,
      version: "0.1.0",
      installState: "installed",
      authState: "authenticated",
      canRun: false,
      statusMessage: "Update Codex CLI to enable agent conversations",
      models: [],
      rateLimits: [],
      metadataState: {
        models: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
        rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      },
    };

    expect(providerStateLabel(provider)).toBe("Update required");
    expect(providerSetupAction(provider)).toBe("refresh");
  });

  it("offers Gemini's interactive setup when static authentication is unknown", () => {
    const provider: ProviderInfo = {
      id: "gemini",
      label: "Gemini",
      command: "gemini",
      available: true,
      version: "0.58.0",
      installState: "installed",
      authState: "unknown",
      canRun: true,
      statusMessage: "Installed; Gemini ACP will verify authentication when a session starts",
      models: [],
      rateLimits: [],
      metadataState: {
        models: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
        rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      },
    };

    expect(providerStateLabel(provider)).toBe("Ready");
    expect(providerSetupAction(provider)).toBe("connect");
  });

  it("offers refresh instead of connection when Gemini ACP needs an update", () => {
    const provider: ProviderInfo = {
      id: "gemini",
      label: "Gemini",
      command: "gemini",
      available: true,
      version: "0.29.5",
      executable: "/opt/bin/gemini",
      installState: "installed",
      authState: "unknown",
      canRun: false,
      statusMessage:
        "Gemini 0.29.5 is installed, but stable ACP requires 0.58.0 or newer; update Gemini",
      models: [],
      rateLimits: [],
      metadataState: {
        models: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
        rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      },
    };

    expect(providerStateLabel(provider)).toBe("Update required");
    expect(providerSetupAction(provider)).toBe("refresh");
  });
});
