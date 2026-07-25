import { describe, expect, it } from "vitest";

import { composerProviderReady } from "../../src/renderer/src/utils/composerReadiness";
import type {
  ModelBackendProfileView,
  ProviderInfo,
} from "../../src/shared/contracts";

function provider(canRun: boolean): ProviderInfo {
  return {
    id: "codex",
    label: "Codex",
    command: "codex",
    available: false,
    version: null,
    executable: null,
    installState: "checking",
    authState: "checking",
    canRun,
    statusMessage: "Checking installation and connection",
    models: [],
    rateLimits: [],
    metadataState: {
      models: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
      rateLimits: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
    },
  };
}

type ReadinessProfile = Pick<
  ModelBackendProfileView,
  "authState" | "connectionState" | "enabled" | "preset"
> & {
  compatibility: Pick<ModelBackendProfileView["compatibility"], "state">;
};

const nativeProfile: ReadinessProfile = {
  preset: "native",
  enabled: true,
  authState: "harness-managed",
  connectionState: "connected",
  compatibility: { state: "verified" },
};

const customProfile: ReadinessProfile = {
  preset: "custom",
  enabled: true,
  authState: "configured",
  connectionState: "connected",
  compatibility: { state: "verified" },
};

describe("composer provider readiness", () => {
  it("uses canRun as the authoritative native-provider readiness signal", () => {
    expect(composerProviderReady(provider(true), nativeProfile)).toBe(true);
    expect(composerProviderReady(provider(false), nativeProfile)).toBe(false);
    expect(composerProviderReady(provider(true), undefined)).toBe(true);
  });

  it("requires provider, authentication, compatibility, and connection readiness for custom backends", () => {
    expect(composerProviderReady(provider(true), customProfile)).toBe(true);
    expect(composerProviderReady(provider(false), customProfile)).toBe(false);
    expect(composerProviderReady(provider(true), {
      ...customProfile,
      authState: "missing",
    })).toBe(false);
    expect(composerProviderReady(provider(true), {
      ...customProfile,
      compatibility: { state: "unknown" },
    })).toBe(false);
    expect(composerProviderReady(provider(true), {
      ...customProfile,
      connectionState: "not-tested",
    })).toBe(false);
  });

  it("accepts the documented Kimi preset before an optional live probe", () => {
    expect(composerProviderReady(provider(true), {
      ...customProfile,
      preset: "kimi-code",
      connectionState: "not-tested",
      compatibility: { state: "partially-compatible" },
    })).toBe(true);
  });
});
