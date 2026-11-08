import { describe, expect, it } from "vitest";

import {
  providerSetupAction,
  providerStateDetail,
  providerStateLabel,
  providerVersionLabel,
} from "../../src/renderer/src/utils/providerStatus";
import type { ProviderInfo } from "../../src/shared/contracts";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";

describe("provider compatibility status", () => {
  it("explains interrupted maintenance without suggesting sign-in or showing checking", () => {
    const providers = initialProviderSnapshots(true, {}, new Set(["claude"]));
    const claude = providers.find(({ id }) => id === "claude")!;
    expect(claude.canRun).toBe(false);
    expect(claude.authState).toBe("unknown");
    expect(providerStateLabel(claude)).toBe("Recovery required");
    expect(providerStateDetail(claude)).toContain("Restart Inertia");
    expect(providerSetupAction(claude)).toBeNull();
    expect(providers.find(({ id }) => id === "codex")?.installState).toBe("checking");
    expect(initialProviderSnapshots(false, {}, new Set(["claude"]))
      .find(({ id }) => id === "claude")?.canRun).toBe(false);
  });
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

  it("offers refresh instead of sign-in when a Codex check did not respond in time", () => {
    const provider: ProviderInfo = {
      id: "codex",
      label: "Codex",
      command: "codex",
      available: true,
      version: "0.1.0",
      installState: "installed",
      authState: "error",
      canRun: false,
      statusMessage: "Codex did not answer the sign-in check in time; refresh to try again",
      models: [],
      rateLimits: [],
      metadataState: {
        models: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
        rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      },
    };

    expect(providerStateLabel(provider)).toBe("Connection issue");
    expect(providerSetupAction(provider)).toBe("refresh");
    const unresponsive = { ...provider, available: false, installState: "unresponsive" as const, authState: "unknown" as const, statusMessage: null };
    expect(providerStateLabel(unresponsive)).toBe("Not responding");
    expect(providerStateDetail(unresponsive)).toBe("Codex did not respond in time.");
    expect(providerSetupAction(unresponsive)).toBe("refresh");
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
      statusMessage: "Antigravity 1.1.0 is installed, but Inertia needs 1.2.2 or newer. Run 'agy update' and refresh.",
    };
    expect(providerStateLabel(outdated)).toBe("Update required");
    expect(providerSetupAction(outdated)).toBe("refresh");
    expect(providerStateDetail(outdated)).toBe(outdated.statusMessage);
    expect(providerStateDetail({ ...ready, installState: "not-installed", statusMessage: null, version: null }))
      .toBe("Antigravity CLI was not found on this device.");
  });

  it.each([
    ["claude", "Claude", "2.1.150", "2.1.309", "Claude Code 2.1.150 is installed. Inertia needs 2.1.309 or newer because older versions ignore the restrictions Inertia sets and can write outside the project. Update Claude Code and refresh."],
    ["opencode", "OpenCode", "1.18.21", "1.18.22", "OpenCode 1.18.21 is installed. Inertia needs 1.18.22 or newer because older versions let a website install packages through OpenCode's local server. Update OpenCode and refresh."],
  ] as const)("shows that %s needs an update instead of a sign-in below Inertia's minimum version", (id, label, version, minimumVersion, statusMessage) => {
    const metadataState: ProviderInfo["metadataState"] = {
      models: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
    };
    const outdated: ProviderInfo = {
      id,
      label,
      command: id,
      available: true,
      version,
      executable: `/opt/bin/${id}`,
      installState: "installed",
      authState: "unknown",
      canRun: false,
      updateRequired: { installedVersion: version, minimumVersion },
      statusMessage,
      models: [],
      rateLimits: [],
      metadataState,
    };
    expect(providerStateLabel(outdated)).toBe("Update required");
    expect(providerSetupAction(outdated)).toBe("refresh");
    expect(providerStateDetail(outdated)).toBe(statusMessage);
  });

  it("prefixes exactly one v whether or not the CLI printed one", () => {
    expect(providerVersionLabel("26.5.0")).toBe("v26.5.0");
    expect(providerVersionLabel("v26.5.0")).toBe("v26.5.0");
    expect(providerVersionLabel("V1.2.2")).toBe("v1.2.2");
    expect(providerVersionLabel("2025.09.12-abc")).toBe("v2025.09.12-abc");
    expect(providerVersionLabel("vnext")).toBe("vvnext");
  });
});
