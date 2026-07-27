import { describe, expect, it } from "vitest";

import type { ModelSelection } from "../../src/shared/model-routing";
import {
  activeWorkIdentityLabel,
  finalAnswerIdentityLabel,
} from "../../src/renderer/src/utils/finalAnswerIdentity";

function selection(update: Partial<ModelSelection> = {}): ModelSelection {
  return {
    harnessId: "claude-agent-sdk",
    backendProfileId: "builtin:anthropic",
    backendProfileDisplayName: "Anthropic",
    modelId: "claude-sonnet-4-5",
    alias: "Sonnet 4.5",
    reasoningEffort: "xhigh",
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: 0,
    ...update,
  };
}

describe("final answer identity", () => {
  it("uses only the persisted harness and backend for active work identity", () => {
    expect(activeWorkIdentityLabel(selection({
      harnessId: "claude-agent-sdk",
      backendProfileDisplayName: "Kimi",
      modelId: "k3",
      alias: "K3",
    }))).toBe("Claude · Kimi");
  });

  it("uses the persisted harness, backend, and friendly model identity", () => {
    expect(finalAnswerIdentityLabel(selection())).toBe(
      "Claude · Anthropic · Sonnet 4.5",
    );
  });

  it("labels Kimi-through-Claude from route identity without matching its backend display name", () => {
    expect(finalAnswerIdentityLabel(selection({
      backendProfileId: "builtin:kimi-code",
      backendProfileDisplayName: "Renamed current profile",
      modelId: "k3",
      alias: null,
    }))).toBe("Claude · Kimi · K3");

    expect(finalAnswerIdentityLabel(selection({
      backendProfileId: "custom:renamed-kimi-route",
      backendProfileDisplayName: "Moonshot coding gateway",
      modelId: "k3",
      alias: null,
    }))).toBe("Claude · Moonshot coding gateway · K3");
  });

  it("keeps custom and unknown historical routes explicit", () => {
    expect(finalAnswerIdentityLabel(selection({
      harnessId: "vendor-harness-v2",
      backendProfileId: "custom:acme",
      backendProfileDisplayName: "Acme Gateway",
      modelId: "acme/code-pro",
      alias: null,
    }))).toBe("vendor-harness-v2 · Acme Gateway · acme/code-pro");
  });

  it("uses persisted structural IDs for native backends without current-profile relabeling", () => {
    expect(finalAnswerIdentityLabel(selection({
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      backendProfileDisplayName: "A mutable catalog label",
      modelId: "gpt-5.6",
      alias: "GPT-5.6",
    }))).toBe("Codex · OpenAI · GPT-5.6");

    expect(finalAnswerIdentityLabel(selection({
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Legacy native label",
      modelId: "gpt-5.6",
      alias: null,
    }))).toBe("Codex · OpenAI · gpt-5.6");
  });

  it("does not invent a model name for provider-default selections", () => {
    expect(finalAnswerIdentityLabel(selection({
      harnessId: "opencode-sdk",
      backendProfileId: "builtin:opencode",
      backendProfileDisplayName: "OpenCode",
      modelId: "provider-default",
      alias: null,
    }))).toBe("OpenCode · OpenCode · Provider default");
  });
});
