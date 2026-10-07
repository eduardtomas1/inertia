import { describe, expect, it } from "vitest";

import {
  modelSelectionSchema,
  providerNativeBackendProfile,
  providerIdForHarness,
  providerNativeModelSelection,
  resolveHarnessBackendCompatibility,
  versionedContinuationIdentityForSelection,
  withModelSelectionFastMode,
  type HarnessBackendCompatibility,
  type ModelBackendProfile,
  type ModelSelection,
} from "../../src/shared/model-routing";
import {
  resolveModelRouteTransition,
  type ModelRouteTransitionCandidate,
  type ModelRouteTransitionContext,
} from "../../src/renderer/src/utils/modelRouteTransition";

const compatibilityToken = "a".repeat(64);

function nativeCandidate(
  selection: ModelSelection,
): ModelRouteTransitionCandidate {
  const providerId = selection.harnessId.startsWith("codex-")
    ? "codex"
    : selection.harnessId.startsWith("claude-")
      ? "claude"
      : selection.harnessId.startsWith("cursor-")
        ? "cursor"
        : "opencode";
  const compatibility = resolveHarnessBackendCompatibility(
    selection.harnessId as Parameters<typeof resolveHarnessBackendCompatibility>[0],
    providerNativeBackendProfile(providerId),
  );
  return {
    selection,
    continuationIdentity: versionedContinuationIdentityForSelection(
      selection,
      null,
      !compatibility.allowsModelSwitchWithinSession,
      compatibilityToken,
    ),
    compatibility,
  };
}

function context(
  selection: ModelSelection,
  candidate: ModelRouteTransitionCandidate,
  update: Partial<ModelRouteTransitionContext> = {},
): ModelRouteTransitionContext {
  return {
    providerId: providerIdForHarness(selection.harnessId) ?? "codex",
    selection,
    continuationIdentity: candidate.continuationIdentity,
    latestTurn: {
      selection,
      continuationIdentity: candidate.continuationIdentity,
    },
    hasProviderSession: true,
    hasHistory: true,
    ...update,
  };
}

function customRoute(
  update: Partial<ModelBackendProfile> = {},
): {
  profile: ModelBackendProfile;
  selection: ModelSelection;
  candidate: ModelRouteTransitionCandidate;
} {
  const profile: ModelBackendProfile = {
    id: "custom:team-gateway",
    displayName: "Team gateway",
    protocol: "openai-responses",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 7,
    endpointIdentity: "endpoint:team-gateway:7",
    ...update,
  };
  const selection = modelSelectionSchema.parse({
    harnessId: "codex-app-server",
    backendProfileId: profile.id,
    backendProfileDisplayName: profile.displayName,
    modelId: "gateway-model-a",
    alias: "Gateway A",
    reasoningEffort: "medium",
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: profile.configurationRevision,
  });
  const compatibility: HarnessBackendCompatibility = {
    harnessId: selection.harnessId,
    backendProfileId: profile.id,
    backendProtocol: profile.protocol,
    state: "partially-compatible",
    provenance: "probe",
    allowsModelSwitchWithinSession: false,
    reasonCode: "responses-probe-verified",
    reason: "The exact Responses route was verified.",
  };
  return {
    profile,
    selection,
    candidate: {
      selection,
      continuationIdentity: versionedContinuationIdentityForSelection(
        selection,
        profile.endpointIdentity,
        true,
        compatibilityToken,
      ),
      compatibility,
    },
  };
}

describe("model route transition policy", () => {
  it("keeps an officially supported native model switch in the current conversation", () => {
    const currentSelection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "gpt-a",
    });
    const currentCandidate = nativeCandidate(currentSelection);
    const nextCandidate = nativeCandidate({
      ...currentSelection,
      modelId: "gpt-b",
      alias: "GPT B",
    });

    expect(resolveModelRouteTransition(
      context(currentSelection, currentCandidate),
      nextCandidate,
    )).toMatchObject({
      changeKind: "model",
      reasonCode: "supported-model-switch",
      continuationAction: "resume-session",
    });
  });

  it("requires current speed-control evidence to leave a Fast session", () => {
    const standard = providerNativeModelSelection({
      providerId: "codex",
      modelId: "gpt-a",
    });
    const fast = withModelSelectionFastMode(standard, "priority");
    const currentCandidate = nativeCandidate(fast);
    const unsupportedStandard = nativeCandidate(standard);

    expect(resolveModelRouteTransition(
      context(fast, currentCandidate),
      unsupportedStandard,
    )).toMatchObject({
      changeKind: "performance-mode",
      reasonCode: "incompatible-performance-mode-changed",
      continuationAction: "start-session",
    });

    expect(resolveModelRouteTransition(
      context(fast, currentCandidate),
      { ...unsupportedStandard, supportsNativeFastModeControl: true },
    )).toMatchObject({
      changeKind: "performance-mode",
      reasonCode: "supported-performance-mode-switch",
    });
  });

  it("keeps the exact same probed custom route without claiming model flexibility", () => {
    const route = customRoute();
    expect(resolveModelRouteTransition(
      context(route.selection, route.candidate),
      route.candidate,
    )).toMatchObject({
      changeKind: "none",
      reasonCode: "same-continuation",
    });
  });

  it("keeps history while starting a fresh session for a custom-backend model change", () => {
    const route = customRoute();
    const nextSelection = {
      ...route.selection,
      modelId: "gateway-model-b",
      alias: "Gateway B",
    };
    const nextCandidate: ModelRouteTransitionCandidate = {
      ...route.candidate,
      selection: nextSelection,
      continuationIdentity: {
        ...route.candidate.continuationIdentity,
        modelIdentity: nextSelection.modelId,
      },
    };

    expect(resolveModelRouteTransition(
      context(route.selection, route.candidate),
      nextCandidate,
    )).toMatchObject({
      changeKind: "model",
      reasonCode: "incompatible-model-changed",
      continuationAction: "start-session",
    });
  });

  it("does not trust an unverified model-switch capability flag", () => {
    const currentSelection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "gpt-a",
    });
    const currentCandidate = nativeCandidate(currentSelection);
    const nextCandidate = nativeCandidate({
      ...currentSelection,
      modelId: "gpt-b",
    });
    nextCandidate.compatibility = {
      state: "partially-compatible",
      allowsModelSwitchWithinSession: true,
    };

    expect(resolveModelRouteTransition(
      context(currentSelection, currentCandidate),
      nextCandidate,
    )).toMatchObject({
      changeKind: "model",
      reasonCode: "incompatible-model-changed",
      continuationAction: "start-session",
    });
  });

  it.each([
    [
      "backend-profile",
      { backendProfileId: "custom:other-gateway" },
      "backend-profile-changed",
      "model backend changed",
    ],
    [
      "backend-configuration",
      { backendConfigurationRevision: 8 },
      "backend-configuration-changed",
      "backend was reconfigured",
    ],
    [
      "endpoint",
      { endpointIdentity: "endpoint:replacement:8" },
      "backend-endpoint-changed",
      "different endpoint",
    ],
  ] as const)(
    "starts a fresh session in the current conversation when the %s boundary changes",
    (changeKind, identityChange, reasonCode, truthfulReason) => {
      const route = customRoute();
      const nextCandidate: ModelRouteTransitionCandidate = {
        ...route.candidate,
        continuationIdentity: {
          ...route.candidate.continuationIdentity,
          ...identityChange,
        },
      };

      const transition = resolveModelRouteTransition(
        context(route.selection, route.candidate),
        nextCandidate,
      );
      expect(transition).toMatchObject({
        changeKind,
        reasonCode,
        continuationAction: "start-session",
      });
      expect(transition.reason).toContain(truthfulReason);
    },
  );

  it.each(["session", "turn", "restored-history", "unused-draft"] as const)(
    "hands another provider this chat's history unless this is an unused draft: %s",
    (evidence) => {
      const selection = providerNativeModelSelection({ providerId: "codex" });
      const current = nativeCandidate(selection);
      const next = nativeCandidate(providerNativeModelSelection({ providerId: "claude" }));
      const transition = resolveModelRouteTransition(context(selection, current, {
        continuationIdentity: null,
        latestTurn: evidence === "turn" ? { selection, continuationIdentity: current.continuationIdentity } : null,
        hasProviderSession: evidence === "session",
        hasHistory: evidence === "restored-history",
      }), next);
      expect(transition).toMatchObject(evidence === "unused-draft" ? {
        reasonCode: "first-turn",
      } : {
        continuationAction: "start-session",
        changeKind: "harness",
        reasonCode: "harness-changed",
        selection: next.selection,
        reason: expect.stringContaining("Earlier messages travel to the new provider as context."),
      });
    },
  );

  it.each(["session", "turn", "history"] as const)(
    "uses the persisted provider for an unknown historical harness with %s evidence",
    (evidence) => {
      const native = providerNativeModelSelection({ providerId: "codex" });
      const selection = { ...native, harnessId: "historical:retired-codex" };
      const identity = { ...nativeCandidate(native).continuationIdentity, harnessId: selection.harnessId };
      const transition = resolveModelRouteTransition({
        providerId: "codex",
        selection,
        continuationIdentity: evidence === "session" ? identity : null,
        latestTurn: evidence === "turn" ? { selection, continuationIdentity: identity } : null,
        hasProviderSession: evidence === "session",
        hasHistory: evidence === "history",
      }, nativeCandidate(providerNativeModelSelection({ providerId: "claude" })));
      expect(transition).toMatchObject({
        continuationAction: "start-session",
        reasonCode: "harness-changed",
      });
    },
  );

  it("does not treat an identical model name on another custom backend as the same route", () => {
    const route = customRoute();
    const other = customRoute({
      id: "custom:other-gateway",
      displayName: "Other gateway",
      endpointIdentity: "endpoint:other-gateway:7",
    });

    expect(resolveModelRouteTransition(
      context(route.selection, route.candidate),
      other.candidate,
    )).toMatchObject({
      changeKind: "backend-profile",
      reasonCode: "backend-profile-changed",
    });
  });

  it("uses the authoritative latest turn instead of a mutable conversation selection", () => {
    const first = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-a" });
    const firstCandidate = nativeCandidate(first);
    const mutableConversationSelection = {
      ...first,
      modelId: "gpt-uncommitted",
    };
    const next = nativeCandidate({ ...first, modelId: "gpt-b" });

    const transition = resolveModelRouteTransition({
      ...context(mutableConversationSelection, firstCandidate),
      latestTurn: {
        selection: first,
        continuationIdentity: firstCandidate.continuationIdentity,
      },
    }, next);
    expect(transition).toMatchObject({
      reasonCode: "supported-model-switch",
    });
  });

  it("rejects an installation-token change for resume without moving the conversation", () => {
    const route = customRoute();
    const changedInstallation = {
      ...route.candidate,
      continuationIdentity: {
        ...route.candidate.continuationIdentity,
        providerCompatibilityToken: "b".repeat(64),
      },
    };
    const transition = resolveModelRouteTransition(
      context(route.selection, route.candidate),
      changedInstallation,
    );
    expect(transition).toMatchObject({
      changeKind: "provider-installation",
      reasonCode: "provider-installation-changed",
      continuationAction: "start-session",
    });
  });

  it("does not lock an unstarted draft conversation to its placeholder route", () => {
    const currentSelection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "provider-default",
    });
    const currentCandidate = nativeCandidate(currentSelection);
    const nextCandidate = nativeCandidate(providerNativeModelSelection({
      providerId: "claude",
      modelId: "claude-sonnet",
    }));

    expect(resolveModelRouteTransition({
      ...context(currentSelection, currentCandidate),
      continuationIdentity: null,
      latestTurn: null,
      hasProviderSession: false,
      hasHistory: false,
    }, nextCandidate)).toMatchObject({
      reasonCode: "first-turn",
      continuationAction: "start-session",
    });
  });
});
