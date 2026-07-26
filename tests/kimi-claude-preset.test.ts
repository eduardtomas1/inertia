import { describe, expect, it } from "vitest";

import {
  KIMI_CODING_MODEL_IDS,
  createKimiClaudeBackendProfile,
  createKimiClaudeModelSelection,
  modelBackendProfileForClaudeProfile,
  modelSelectionIdentityLabel,
  validateKimiClaudeModelSelection,
} from "../src/shared/claude-backend-profiles";
import { continuationIdentityForSelection } from "../src/shared/model-routing";

const SECRET_REFERENCE = "secret:kimi-preset-test";

describe("verified Kimi-through-Claude selection", () => {
  it.each(KIMI_CODING_MODEL_IDS)("creates a canonical selection for %s", (modelId) => {
    const profile = createKimiClaudeBackendProfile({
      id: `kimi:${modelId}`,
      secretReference: SECRET_REFERENCE,
      primaryModelId: modelId,
    });
    const selection = createKimiClaudeModelSelection({ profile });

    expect(selection).toMatchObject({
      harnessId: "claude-agent-sdk",
      backendProfileId: profile.id,
      backendProfileDisplayName: "Kimi",
      modelId,
      alias: null,
      reasoningEffort: "high",
      contextWindowOverride: 262_144,
      providerOptions: {},
      backendConfigurationRevision: profile.configurationRevision,
    });
    expect(validateKimiClaudeModelSelection(profile, selection)).toEqual(selection);
  });

  it("keeps the API model exact while rendering a truthful persisted identity", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:historical-k3",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
      contextWindowTokens: 1_048_576,
    });
    const selection = createKimiClaudeModelSelection({ profile });

    expect(selection.modelId).toBe("k3");
    expect(modelSelectionIdentityLabel(selection)).toBe("Claude harness · Kimi · K3");
    expect(modelSelectionIdentityLabel({
      ...selection,
      backendProfileDisplayName: "Historical Kimi",
    })).toBe("Claude harness · Historical Kimi · K3");
  });

  it("rejects unsupported IDs and forged safe metadata before launch", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:validated-selection",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
    });
    const selection = createKimiClaudeModelSelection({ profile });

    expect(() => createKimiClaudeModelSelection({
      profile,
      modelId: "not-a-kimi-model" as "k3",
    })).toThrow(/model ID is not currently supported/u);
    expect(() => validateKimiClaudeModelSelection(profile, {
      ...selection,
      contextWindowOverride: 1_048_576,
    })).toThrow(/does not match/u);
    expect(() => validateKimiClaudeModelSelection(profile, {
      ...selection,
      capabilities: selection.capabilities.map((capability) => (
        capability.id === "structured-output"
          ? { ...capability, state: "verified" as const }
          : capability
      )),
    })).toThrow(/does not match/u);
  });

  it("keeps continuation locked to the profile revision, endpoint, and exact model", () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:continuation",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
    });
    const selection = createKimiClaudeModelSelection({ profile });
    const backend = modelBackendProfileForClaudeProfile(profile);
    const identity = continuationIdentityForSelection(
      selection,
      backend.endpointIdentity,
      true,
    );

    expect(identity).toEqual({
      harnessId: "claude-agent-sdk",
      backendProfileId: profile.id,
      backendConfigurationRevision: profile.configurationRevision,
      modelIdentity: "k3",
      endpointIdentity: "kimi-code:anthropic-messages-v1",
    });
    expect(selection.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "reasoning", state: "verified" }),
      expect.objectContaining({ id: "tools", state: "partially-compatible" }),
      expect.objectContaining({ id: "usage", state: "partially-compatible" }),
      expect.objectContaining({ id: "structured-output", state: "unavailable" }),
      expect.objectContaining({ id: "session-continuation", state: "unknown" }),
    ]));
  });
});
