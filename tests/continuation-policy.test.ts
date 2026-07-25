import { describe, expect, it } from "vitest";

import {
  resolveContinuationDecision,
  staleProviderSessionDecision,
} from "../src/shared/continuation-policy";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../src/shared/model-routing";

const codex = nativeModelSelection({
  providerId: "codex",
  modelId: "gpt-5.4",
});
const codexIdentity = continuationIdentityForSelection(codex, null, false);

describe("provider continuation policy", () => {
  it("starts the first turn without requiring a persisted identity", () => {
    expect(resolveContinuationDecision({
      previousIdentity: null,
      nextIdentity: codexIdentity,
      previousModelId: null,
      nextModelId: codex.modelId,
      hasProviderSession: false,
      hasTurns: false,
      allowsModelSwitchWithinSession: true,
    })).toMatchObject({
      action: "start-session",
      reasonCode: "first-turn",
    });
  });

  it("does not lock a draft chat before it has an authoritative turn", () => {
    expect(resolveContinuationDecision({
      previousIdentity: codexIdentity,
      nextIdentity: {
        ...codexIdentity,
        harnessId: "claude-agent-sdk",
        backendProfileId: "claude-native",
      },
      previousModelId: codex.modelId,
      nextModelId: "claude-provider-default",
      hasProviderSession: false,
      hasTurns: false,
      allowsModelSwitchWithinSession: true,
    })).toMatchObject({
      action: "start-session",
      changeKind: "harness",
      reasonCode: "first-turn",
    });
  });

  it("resumes only an exactly bound provider session", () => {
    expect(resolveContinuationDecision({
      previousIdentity: codexIdentity,
      nextIdentity: { ...codexIdentity },
      previousModelId: codex.modelId,
      nextModelId: codex.modelId,
      hasProviderSession: true,
      hasTurns: true,
      allowsModelSwitchWithinSession: true,
    })).toMatchObject({
      action: "resume-session",
      changeKind: "none",
      reasonCode: "same-continuation",
    });
  });

  it("allows a documented model switch without hiding that the model changed", () => {
    expect(resolveContinuationDecision({
      previousIdentity: codexIdentity,
      nextIdentity: { ...codexIdentity },
      previousModelId: "gpt-5.4",
      nextModelId: "gpt-5.5",
      hasProviderSession: true,
      hasTurns: true,
      allowsModelSwitchWithinSession: true,
    })).toMatchObject({
      action: "resume-session",
      changeKind: "model",
      reasonCode: "supported-model-switch",
    });
  });

  it("requires a new conversation for unsupported model changes", () => {
    const cursor = nativeModelSelection({
      providerId: "cursor",
      modelId: "cursor-model-a",
    });
    const previous = continuationIdentityForSelection(cursor);
    expect(resolveContinuationDecision({
      previousIdentity: previous,
      nextIdentity: { ...previous, modelIdentity: "cursor-model-b" },
      previousModelId: "cursor-model-a",
      nextModelId: "cursor-model-b",
      hasProviderSession: true,
      hasTurns: true,
      allowsModelSwitchWithinSession: false,
    })).toMatchObject({
      action: "new-conversation-required",
      changeKind: "model",
      reasonCode: "incompatible-model-changed",
    });
  });

  it("honors a model-bound continuation identity even if a capability flag is contradictory", () => {
    const cursor = nativeModelSelection({
      providerId: "cursor",
      modelId: "cursor-model-a",
    });
    const previous = continuationIdentityForSelection(cursor);
    expect(resolveContinuationDecision({
      previousIdentity: previous,
      nextIdentity: { ...previous, modelIdentity: "cursor-model-b" },
      previousModelId: "cursor-model-a",
      nextModelId: "cursor-model-b",
      hasProviderSession: true,
      hasTurns: true,
      allowsModelSwitchWithinSession: true,
    })).toMatchObject({
      action: "new-conversation-required",
      changeKind: "model",
      reasonCode: "incompatible-model-changed",
    });
  });

  it.each([
    ["harness", { harnessId: "claude-agent-sdk" }, "harness-changed"],
    ["backend-profile", { backendProfileId: "custom:other" }, "backend-profile-changed"],
    [
      "backend-configuration",
      { backendConfigurationRevision: 2 },
      "backend-configuration-changed",
    ],
    ["endpoint", { endpointIdentity: "endpoint:other" }, "backend-endpoint-changed"],
  ] as const)(
    "requires a new conversation after a %s boundary change",
    (_label, change, reasonCode) => {
      expect(resolveContinuationDecision({
        previousIdentity: codexIdentity,
        nextIdentity: { ...codexIdentity, ...change },
        previousModelId: codex.modelId,
        nextModelId: codex.modelId,
        hasProviderSession: true,
        hasTurns: true,
        allowsModelSwitchWithinSession: true,
      })).toMatchObject({
        action: "new-conversation-required",
        reasonCode,
      });
    },
  );

  it("keeps an authoritative turn as a hard boundary even before a provider session is saved", () => {
    expect(resolveContinuationDecision({
      previousIdentity: codexIdentity,
      nextIdentity: {
        ...codexIdentity,
        backendProfileId: "custom:other",
      },
      previousModelId: codex.modelId,
      nextModelId: codex.modelId,
      hasProviderSession: false,
      hasTurns: true,
      allowsModelSwitchWithinSession: true,
    })).toMatchObject({
      action: "new-conversation-required",
      changeKind: "backend-profile",
      reasonCode: "backend-profile-changed",
    });
  });

  it("may start a missing provider session only when the authoritative route still matches", () => {
    expect(resolveContinuationDecision({
      previousIdentity: codexIdentity,
      nextIdentity: { ...codexIdentity },
      previousModelId: codex.modelId,
      nextModelId: codex.modelId,
      hasProviderSession: false,
      hasTurns: true,
      allowsModelSwitchWithinSession: true,
    })).toMatchObject({
      action: "start-session",
      changeKind: "none",
      reasonCode: "same-route-without-session",
    });
  });

  it("fails safe for a legacy or malformed bound session with no identity", () => {
    expect(resolveContinuationDecision({
      previousIdentity: null,
      nextIdentity: codexIdentity,
      previousModelId: null,
      nextModelId: codex.modelId,
      hasProviderSession: true,
      hasTurns: false,
      allowsModelSwitchWithinSession: true,
    })).toMatchObject({
      action: "new-conversation-required",
      changeKind: "missing-identity",
      reasonCode: "missing-continuation-identity",
    });
  });

  it("fails safe when persisted identity metadata contradicts the last turn", () => {
    expect(resolveContinuationDecision({
      previousIdentity: {
        ...codexIdentity,
        modelIdentity: "unexpected-model",
      },
      nextIdentity: codexIdentity,
      previousModelId: codex.modelId,
      nextModelId: codex.modelId,
      hasProviderSession: true,
      hasTurns: true,
      allowsModelSwitchWithinSession: true,
    })).toMatchObject({
      action: "new-conversation-required",
      changeKind: "missing-identity",
      reasonCode: "missing-continuation-identity",
    });
  });

  it("provides a stable action when the provider no longer has the saved session", () => {
    expect(staleProviderSessionDecision()).toMatchObject({
      action: "new-conversation-required",
      reasonCode: "stale-provider-session",
    });
  });
});
