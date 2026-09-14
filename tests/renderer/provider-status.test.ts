import { describe, expect, it } from "vitest";

import {
  providerSetupAction,
  providerStateDetail,
  providerStateLabel,
  providerVersionLabel,
} from "../../src/renderer/src/utils/providerStatus";
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

  it("treats Antigravity sign-in as checked per turn and version-gated", () => {
    const metadataState: ProviderInfo["metadataState"] = {
      models: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
    };
    const ready: ProviderInfo = {
      id: "antigravity",
      label: "Antigravity",
      command: "agy",
      available: true,
      version: "1.2.2",
      executable: "/opt/bin/agy",
      installState: "installed",
      authState: "unknown",
      canRun: true,
      statusMessage: "Installed; Antigravity checks your sign-in when a turn starts",
      models: [],
      rateLimits: [],
      metadataState,
    };
    expect(providerStateLabel(ready)).toBe("Ready");
    expect(providerSetupAction(ready)).toBe("connect");

    const outdated: ProviderInfo = {
      ...ready,
      version: "1.1.0",
      canRun: false,
      statusMessage: "Antigravity 1.1.0 is installed, but Inertia needs 1.2.2 or newer; run 'agy update'",
    };
    expect(providerStateLabel(outdated)).toBe("Update required");
    expect(providerSetupAction(outdated)).toBe("refresh");
    expect(providerStateDetail({ ...ready, installState: "not-installed", statusMessage: null, version: null }))
      .toBe("Antigravity CLI was not found on this device.");
  });

  it("prefixes exactly one v whether or not the CLI printed one", () => {
    expect(providerVersionLabel("26.5.0")).toBe("v26.5.0");
    expect(providerVersionLabel("v26.5.0")).toBe("v26.5.0");
    expect(providerVersionLabel("V1.2.2")).toBe("v1.2.2");
    expect(providerVersionLabel("2025.09.12-abc")).toBe("v2025.09.12-abc");
    expect(providerVersionLabel("vnext")).toBe("vvnext");
  });
});
