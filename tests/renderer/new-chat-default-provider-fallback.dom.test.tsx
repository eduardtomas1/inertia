import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NewChatDefaults } from "../../src/renderer/src/components/settings/sections/NewChatDefaults";
import { defaultSettings, type ProviderInfo } from "../../src/shared/contracts";
import { provider } from "./composer-fixtures";

const codexMissing: ProviderInfo = { ...provider, available: false, installState: "not-installed", authState: "unknown", canRun: false };
const claudeReady: ProviderInfo = { ...provider, id: "claude", label: "Claude", command: "claude", executable: "/opt/bin/claude" };

function renderDefaults(providers: ProviderInfo[], onSetDefaultModel = vi.fn(async () => undefined)) {
  return render(<NewChatDefaults settings={{ ...defaultSettings, defaultProvider: "codex" }} disabled={false} providers={providers}
    backendProfiles={[]} backendDefaults={[]} onUpdate={vi.fn()} onSetDefaultModel={onSetDefaultModel} onSetBackendDefault={vi.fn()} />);
}

const claudeWithLevels: ProviderInfo = {
  ...claudeReady,
  models: [{
    id: "claude-test", label: "Claude Test", description: "", isDefault: true, inputModalities: ["text"],
    reasoningOptions: [{ value: "low", label: "Low", description: "" }, { value: "high", label: "High", description: "" }],
    defaultReasoningEffort: "low",
  }],
};

describe("new chat default provider fallback", () => {
  it("says which provider new chats use when the stored one is unavailable", () => {
    const { container } = renderDefaults([codexMissing, claudeReady]);
    expect(container.querySelector('[data-setting-id="new-chat-model"]'))
      .toHaveTextContent("Codex is not available, so new chats use Claude.");
  });

  it("keeps Reasoning unavailable during the fallback so it cannot store the fallback provider", () => {
    const onSetDefaultModel = vi.fn(async () => undefined);
    const { container } = renderDefaults([codexMissing, claudeWithLevels], onSetDefaultModel);
    const reasoning = screen.getByRole("combobox", { name: "Reasoning" });
    expect(reasoning).toHaveAttribute("aria-disabled", "true");
    expect(container.querySelector('[data-setting-id="new-chat-reasoning"]'))
      .toHaveTextContent("Choose a model to change its reasoning.");
    fireEvent.change(reasoning, { target: { value: "high" } });
    expect(onSetDefaultModel).not.toHaveBeenCalled();
  });

  it("states the Full access caution on the Access row whatever is chosen", () => {
    const { container } = renderDefaults([provider, claudeReady]);
    expect(container.querySelector('[data-setting-id="new-chat-access"]'))
      .toHaveTextContent("Full access lets the agent act without asking. Choose it only for a workspace and task you trust.");
  });

  it("says nothing extra while the stored provider is ready", () => {
    const { container } = renderDefaults([provider, claudeReady]);
    expect(container.querySelector('[data-setting-id="new-chat-model"]')).not.toHaveTextContent("is not available");
  });
});
