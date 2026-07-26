import { describe, expect, it } from "vitest";

import type { ModelSelection } from "../../src/shared/model-routing";
import { finalAnswerIdentityLabel } from "../../src/renderer/src/utils/finalAnswerIdentity";

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
  it("uses the persisted harness, backend, and friendly model identity", () => {
    expect(finalAnswerIdentityLabel(selection())).toBe(
      "Claude · Anthropic · Sonnet 4.5",
    );
  });

  it("labels Kimi-through-Claude from route identity without matching its backend display name", () => {
    expect(finalAnswerIdentityLabel(selection({
      backendProfileId: "builtin:kimi-code",
      backendProfileDisplayName: "Kimi",
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

  it("does not invent a model name for provider-default selections", () => {
    expect(finalAnswerIdentityLabel(selection({
      harnessId: "opencode-sdk",
      backendProfileDisplayName: "OpenCode",
      modelId: "provider-default",
      alias: null,
    }))).toBe("OpenCode · OpenCode · Provider default");
  });
});
