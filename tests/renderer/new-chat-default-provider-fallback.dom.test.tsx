import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NewChatDefaults } from "../../src/renderer/src/components/settings/sections/NewChatDefaults";
import { defaultSettings, type ProviderInfo } from "../../src/shared/contracts";
import { provider } from "./composer-fixtures";

const codexMissing: ProviderInfo = { ...provider, available: false, installState: "not-installed", authState: "unknown", canRun: false };
const claudeReady: ProviderInfo = { ...provider, id: "claude", label: "Claude", command: "claude", executable: "/opt/bin/claude" };

function renderDefaults(providers: ProviderInfo[]) {
  return render(<NewChatDefaults settings={{ ...defaultSettings, defaultProvider: "codex" }} disabled={false} providers={providers}
    backendProfiles={[]} backendDefaults={[]} onUpdate={vi.fn()} onSetDefaultModel={vi.fn()} onSetBackendDefault={vi.fn()} />);
}

describe("new chat default provider fallback", () => {
  it("says which provider new chats use when the stored one is unavailable", () => {
    const { container } = renderDefaults([codexMissing, claudeReady]);
    expect(container.querySelector('[data-setting-id="new-chat-model"]'))
      .toHaveTextContent("Codex is not available, so new chats use Claude.");
  });

  it("says nothing extra while the stored provider is ready", () => {
    const { container } = renderDefaults([provider, claudeReady]);
    expect(container.querySelector('[data-setting-id="new-chat-model"]')).not.toHaveTextContent("is not available");
  });
});
