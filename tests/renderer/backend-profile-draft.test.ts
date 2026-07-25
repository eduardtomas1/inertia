import { describe, expect, it } from "vitest";

import type { ModelBackendProfileDraft } from "../../src/shared/contracts";
import {
  backendProfileIsReady,
  setBackendDraftAdvancedRouting,
  updateBackendDraftModel,
} from "../../src/renderer/src/utils/backendProfileDraft";

function draft(): ModelBackendProfileDraft {
  return {
    displayName: "Long-lived team gateway",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "none",
    preset: "custom",
    baseUrl: "https://gateway.example.test/v1",
    allowInsecureLocalhost: false,
    models: [
      {
        id: "primary-model",
        displayName: "Primary model",
        contextWindowTokens: 200_000,
        reasoningOptions: [],
        capabilities: [],
      },
      {
        id: "secondary-model",
        displayName: "Secondary model",
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
      },
    ],
    routing: {
      mode: "advanced",
      primaryModelId: "primary-model",
      tierModels: {
        fable: "secondary-model",
        opus: "primary-model",
        sonnet: "secondary-model",
        haiku: "secondary-model",
      },
      subagentModelId: "secondary-model",
    },
    capabilityHints: [],
  };
}

describe("model backend editor routing", () => {
  it("shows readiness only with usable auth and a tested usable connection", () => {
    const base = {
      enabled: true,
      authState: "configured" as const,
      connectionState: "connected" as const,
      compatibility: { state: "verified" as const },
    };

    expect(backendProfileIsReady(base)).toBe(true);
    expect(backendProfileIsReady({
      ...base,
      authState: "unavailable",
    })).toBe(false);
    expect(backendProfileIsReady({
      ...base,
      connectionState: "not-tested",
    })).toBe(false);
    expect(backendProfileIsReady({
      ...base,
      connectionState: "limited",
      compatibility: { state: "partially-compatible" },
    })).toBe(true);
  });

  it("renames a non-primary model without silently making it primary", () => {
    const next = updateBackendDraftModel(
      draft(),
      1,
      "id",
      "secondary-model-with-a-very-long-identifier",
    );

    expect(next.routing.primaryModelId).toBe("primary-model");
    expect(next.routing).toMatchObject({
      tierModels: {
        fable: "secondary-model-with-a-very-long-identifier",
        opus: "primary-model",
      },
      subagentModelId: "secondary-model-with-a-very-long-identifier",
    });
  });

  it("preserves a valid primary model when advanced mapping is toggled", () => {
    const simple = setBackendDraftAdvancedRouting(draft(), false);
    const advanced = setBackendDraftAdvancedRouting(simple, true);

    expect(simple.routing).toEqual({
      mode: "simple",
      primaryModelId: "primary-model",
    });
    expect(advanced.routing.primaryModelId).toBe("primary-model");
    expect(advanced.routing).toMatchObject({
      tierModels: {
        fable: "primary-model",
        opus: "primary-model",
        sonnet: "primary-model",
        haiku: "primary-model",
      },
      subagentModelId: "primary-model",
    });
  });
});
