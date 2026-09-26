import { validateProviderRunInput } from "../../src/server/provider/adapters";
import { describe, expect, it } from "vitest";

import type { ProviderId, ProviderRunInput } from "../../src/server/provider/contracts";
import { nativeProviderRunFields } from "./model-route-fixture";
import {
  continuationIdentityForSelection,
  withModelSelectionFastMode,
} from "../../src/shared/model-routing";

function input(providerId: ProviderId, overrides: Partial<ProviderRunInput> = {}): ProviderRunInput {
  return {
    ...nativeProviderRunFields(providerId),
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    cwd: "/workspace",
    prompt: "Inspect this project",
    interactionMode: "build",
    access: "supervised",
    ...overrides,
  } as ProviderRunInput;
}

describe("provider adapter seams", () => {
  it("validates the stable provider run contract before launching", () => {
    expect(validateProviderRunInput(input("claude"))).toBe("conversation-1");
    expect(() => validateProviderRunInput(input("claude", { prompt: "" }))).toThrow("A prompt is required.");
    expect(() => validateProviderRunInput(input("claude", { imagePaths: ["bad\0path"] }))).toThrow("An image path is invalid.");
  });

  it("owns a provider control operation with an explicit correlation identity", () => {
    expect(validateProviderRunInput(input("claude", {
      runId: "compact-operation-1",
      turnId: "compact-correlation-1",
      sessionId: "session-1",
      operation: { kind: "compact" },
    }))).toBe("conversation-1");
    expect(() => validateProviderRunInput({
      ...input("claude"),
      turnId: undefined,
    } as unknown as ProviderRunInput)).toThrow("Exact run and turn identities are required.");
    expect(() => validateProviderRunInput(input("claude", {
      runId: "compact-operation-1",
      sessionId: "session-1",
      supportedFastMode: "fast",
      performanceModeTransition: "to-standard",
      operation: { kind: "compact" },
    }))).toThrow("provider compaction request is invalid");
  });

  it("validates provider-native Fast mode and continuation transitions exactly", () => {
    const codex = input("codex");
    const fastSelection = withModelSelectionFastMode(
      codex.modelSelection,
      "priority",
    );
    const fastInput = {
      ...codex,
      supportedFastMode: "priority" as const,
      modelSelection: fastSelection,
      continuationIdentity: continuationIdentityForSelection(
        fastSelection,
        null,
        false,
      ),
    };
    expect(validateProviderRunInput(fastInput)).toBe("conversation-1");
    expect(() => validateProviderRunInput({
      ...fastInput,
      modelSelection: {
        ...fastSelection,
        providerOptions: { fastMode: "priority", temperature: 0 },
      },
    })).toThrow("Fast mode route is invalid");

    const cursor = input("cursor");
    expect(() => validateProviderRunInput({
      ...cursor,
      modelSelection: {
        ...cursor.modelSelection,
        providerOptions: { fastMode: "priority" },
      },
      continuationIdentity: {
        ...cursor.continuationIdentity,
        performanceModeIdentity: "fast:priority",
      },
    })).toThrow("Fast mode route is invalid");
    expect(() => validateProviderRunInput({
      ...fastInput,
      performanceModeTransition: "to-fast",
    })).toThrow("continuation transition is invalid");
    expect(validateProviderRunInput({
      ...codex,
      supportedFastMode: "priority",
      sessionId: "thread-fast",
      performanceModeTransition: "to-standard",
    })).toBe("conversation-1");
    expect(validateProviderRunInput({
      ...codex,
      supportedFastMode: "priority",
    })).toBe("conversation-1");
    expect(() => validateProviderRunInput({
      ...codex,
      supportedFastMode: "fast",
    })).toThrow("Fast mode route is invalid");
    expect(() => validateProviderRunInput({
      ...codex,
      harnessId: "codex-cli",
      sessionId: "thread-fast",
      performanceModeTransition: "to-standard",
    })).toThrow("continuation transition is invalid");
    expect(() => validateProviderRunInput({
      ...codex,
      backendProfile: {
        ...codex.backendProfile,
        id: "custom:openai",
      },
      sessionId: "thread-fast",
      performanceModeTransition: "to-standard",
    })).toThrow("continuation transition is invalid");
  });

  it("accepts bounded Codex goal starts with or without an established session", () => {
    expect(validateProviderRunInput(input("codex", {
      sessionId: "thread-1",
      goalStart: { objective: "Ship the goal", tokenBudget: 12_000 },
      goalContinuationExpected: true,
    }))).toBe("conversation-1");
    expect(validateProviderRunInput(input("codex", {
      sessionId: "thread-1",
      goalStart: { objective: "Ship without a budget", tokenBudget: null },
    }))).toBe("conversation-1");
    expect(validateProviderRunInput(input("codex", {
      goalStart: { objective: "Create the first session" },
      goalContinuationExpected: true,
    }))).toBe("conversation-1");
    expect(() => validateProviderRunInput(input("claude", {
      sessionId: "session-1",
      goalStart: { objective: "Wrong provider" },
    }))).toThrow("native goal start request is invalid");
    for (const tokenBudget of [0, 1_000_000_001, 1.5]) {
      expect(() => validateProviderRunInput(input("codex", {
        sessionId: "thread-1",
        goalStart: { objective: "Invalid budget", tokenBudget },
      }))).toThrow("native goal start request is invalid");
    }
    expect(() => validateProviderRunInput(input("codex", {
      sessionId: "thread-1",
      goalStart: { objective: "  " },
    }))).toThrow("native goal start request is invalid");
    expect(() => validateProviderRunInput(input("codex", {
      goalContinuationExpected: "yes" as unknown as boolean,
    }))).toThrow("goal continuation hint is invalid");
    expect(() => validateProviderRunInput(input("claude", {
      sessionId: "session-1",
      goalContinuationExpected: true,
    }))).toThrow("goal continuation hint is invalid");
  });
});
