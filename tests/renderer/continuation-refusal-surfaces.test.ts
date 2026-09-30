import { describe, expect, it } from "vitest";

import {
  chatResumeAvailability,
  planActionsAvailable,
} from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import {
  conversationContinuationRefusal,
  MIXED_PROVIDER_HISTORY_MESSAGE,
} from "../../src/shared/continuation-policy";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { providerTerminalResumeAvailability } from "../../src/shared/provider-terminal-resume";

const resumable = {
  providerId: "codex" as const,
  modelSelection: providerNativeModelSelection({ providerId: "codex" }),
  continuationIdentity: null,
  providerSessionId: "019a0000-0000-7000-8000-000000000001",
  status: "idle" as const,
};

describe("chat continuation refusal surfaces", () => {
  it("derives the refusal only from the published mixed-provider fact", () => {
    expect(conversationContinuationRefusal({ mixedProviderHistory: true })).toBe(MIXED_PROVIDER_HISTORY_MESSAGE);
    expect(conversationContinuationRefusal({ mixedProviderHistory: false })).toBeNull();
    expect(conversationContinuationRefusal({})).toBeNull();
    expect(conversationContinuationRefusal(null)).toBeNull();
  });

  it("withholds plan refinement and implementation for a chat that cannot continue", () => {
    expect(planActionsAvailable({ status: "idle" }, MIXED_PROVIDER_HISTORY_MESSAGE)).toBe(false);
    expect(planActionsAvailable({ status: "idle" }, null)).toBe(true);
    expect(planActionsAvailable({ status: "running" }, null)).toBe(false);
  });

  it("marks the chat's terminal resume unavailable with the explanation", () => {
    expect(chatResumeAvailability(resumable, undefined, MIXED_PROVIDER_HISTORY_MESSAGE)).toEqual({
      kind: "unavailable",
      resume: null,
      reason: MIXED_PROVIDER_HISTORY_MESSAGE,
    });
    const provider = {
      id: "codex" as const, label: "Codex", available: true, version: "0.130.0",
      installState: "installed" as const, canRun: true, statusMessage: null,
    };
    expect(chatResumeAvailability(resumable, provider, null))
      .toEqual(providerTerminalResumeAvailability(resumable, provider));
    expect(chatResumeAvailability(resumable, provider, null))
      .not.toEqual(chatResumeAvailability(resumable, provider, MIXED_PROVIDER_HISTORY_MESSAGE));
  });
});
