import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import { AddProviderMenu } from "../../src/renderer/src/components/settings/AddProviderMenu";
import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { settingsViewProps } from "./settings-view-fixtures";

function provider(
  id: ProviderInfo["id"],
  authState: ProviderInfo["authState"],
  canRun: boolean,
): ProviderInfo {
  const metadata = {
    freshness: "unavailable" as const,
    provenance: null,
    updatedAt: null,
    lastAttemptedAt: null,
    refreshing: false,
  };
  return {
    id,
    label: id,
    command: id,
    available: true,
    version: null,
    installState: "installed",
    authState,
    canRun,
    statusMessage: null,
    models: [],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

function renderMenu(providers: ProviderInfo[]) {
  const onClose = vi.fn();
  const onConnectProvider = vi.fn();
  const onAddApiKey = vi.fn();
  const onCommitIdentityLabel = vi.fn();
  const onSelectProvider = vi.fn();
  render(
    <AddProviderMenu
      providers={providers}
      providerIdentityLabels={{}}
      codexBinaryPath=""
      disabled={false}
      onClose={onClose}
      onSelectProvider={onSelectProvider}
      onConnectProvider={onConnectProvider}
      onRefreshProvider={vi.fn()}
      onCommitIdentityLabel={onCommitIdentityLabel}
      onChooseCodexBinary={vi.fn()}
      onUseAutomaticCodexBinary={vi.fn()}
      onAddApiKey={onAddApiKey}
    />,
  );
  return { onClose, onConnectProvider, onAddApiKey, onCommitIdentityLabel, onSelectProvider };
}

describe("Add provider menu", () => {
  it("moves through the provider grid and starts Codex sign-in", () => {
    const { onConnectProvider, onClose, onSelectProvider } = renderMenu([
      provider("codex", "unauthenticated", false),
      provider("claude", "unauthenticated", false),
    ]);
    const dialog = screen.getByRole("dialog", { name: "Add provider" });
    const codex = within(dialog).getByRole("radio", { name: /^Codex,/ });
    expect(codex).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByRole("radio", { name: /^Grok,/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /^Kimi Code,/ })).toBeInTheDocument();
    expect(within(dialog).getByText(/ChatGPT account/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "More info" }));
    expect(within(dialog).getByText(/one Codex installation/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Show more" }));
    expect(within(dialog).getByText("ChatGPT account, through Codex's own login.")).toBeInTheDocument();
    fireEvent.keyDown(codex, { key: "ArrowRight" });
    expect(within(dialog).getByRole("radio", { name: /^Claude,/ })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByRole("button", { name: "Next" })).toBeInTheDocument();
    fireEvent.keyDown(within(dialog).getByRole("radio", { name: /^Claude,/ }), { key: "ArrowLeft" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue with ChatGPT" }));
    expect(onSelectProvider).toHaveBeenCalledWith("codex");
    expect(onConnectProvider).toHaveBeenCalledWith("codex", "account");
    expect(onClose).toHaveBeenCalled();
  });

  it("saves an account name and opens the API key dialog from the config step", () => {
    const { onAddApiKey, onCommitIdentityLabel, onClose } = renderMenu([
      provider("codex", "authenticated", true),
    ]);
    const dialog = screen.getByRole("dialog", { name: "Add provider" });
    expect(within(dialog).getByText(/already signed in/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Configure manually" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Account name" }), {
      target: { value: "Work" },
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: /API key/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add API key" }));
    expect(onCommitIdentityLabel).toHaveBeenCalledWith("codex", "Work");
    expect(onAddApiKey).toHaveBeenCalledWith("codex");
    expect(onClose).toHaveBeenCalled();
  });

  it("opens from Agents and hands an API key to the existing key dialog", async () => {
    const onConnectProvider = vi.fn();
    render(<SettingsView {...settingsViewProps({
      target: { section: "agents" },
      providers: [provider("codex", "unauthenticated", false)],
      onConnectProvider,
    })} />);
    expect(await screen.findByRole("region", { name: "Codex" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const dialog = screen.getByRole("dialog", { name: "Add provider" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue with ChatGPT" }));
    expect(onConnectProvider).toHaveBeenCalledWith("codex", "account");
    expect(screen.queryByRole("dialog", { name: "Add provider" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const again = screen.getByRole("dialog", { name: "Add provider" });
    fireEvent.click(within(again).getByRole("button", { name: "Configure manually" }));
    fireEvent.click(within(again).getByRole("radio", { name: /API key/ }));
    fireEvent.click(within(again).getByRole("button", { name: "Next" }));
    fireEvent.click(within(again).getByRole("button", { name: "Add API key" }));
    expect(await screen.findByRole("dialog", { name: "Add OpenAI API key" })).toBeInTheDocument();
  });
});
