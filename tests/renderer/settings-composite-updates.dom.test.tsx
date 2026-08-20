import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { defaultSettings, type ProviderInfo } from "../../src/shared/contracts";

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

function provider(id: "codex" | "claude", label: string): ProviderInfo {
  return {
    id,
    label,
    command: id,
    available: true,
    version: "1.0.0",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [],
    rateLimits: [],
    metadataState: {
      models: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
      rateLimits: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
    },
  };
}

function codexWithModels(): ProviderInfo {
  const codex = provider("codex", "Codex");
  return {
    ...codex,
    models: [{
      id: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      description: "Default Codex model",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [{
        value: "low",
        label: "Low",
        description: "Quick reasoning",
      }, {
        value: "xhigh",
        label: "Xhigh",
        description: "Deep reasoning",
      }],
      defaultReasoningEffort: "low",
    }, {
      id: "gpt-5.6-terra",
      label: "GPT-5.6-Terra",
      description: "Balanced Codex model",
      isDefault: false,
      inputModalities: ["text"],
      reasoningOptions: [{
        value: "medium",
        label: "Medium",
        description: "Balanced reasoning",
      }],
      defaultReasoningEffort: "medium",
    }],
    metadataState: {
      ...codex.metadataState,
      models: {
        freshness: "fresh",
        provenance: "provider",
        updatedAt: "2026-08-17T10:00:00.000Z",
        lastAttemptedAt: "2026-08-17T10:00:00.000Z",
        refreshing: false,
      },
    },
  };
}

function settingsProps(
  onUpdate: ComponentProps<typeof SettingsView>["onUpdate"],
): ComponentProps<typeof SettingsView> {
  return {
    settings: defaultSettings,
    disabled: false,
    providers: [provider("codex", "Codex"), provider("claude", "Claude")],
    backendProfiles: [],
    backendDefaults: [],
    projects: [],
    conversations: [],
    archived: [],
    onUpdate,
    onConnectProvider: vi.fn(),
    onRefreshProvider: vi.fn(),
    maintenanceOperations: new Map(),
    maintenanceStatuses: new Map(),
    onRefreshProviderMaintenance: vi.fn(async () => undefined),
    onUpdateProvider: vi.fn(async () => undefined),
    onCancelProviderUpdate: vi.fn(async () => undefined),
    onOpenProviderUpdateInstructions: vi.fn(),
    onChooseCodexBinary: vi.fn(),
    onRevealRuntimeLogs: vi.fn(async () => ""),
    onCopyRuntimeDiagnosticReport: vi.fn(async () => ({
      copied: true,
      eventCount: 0,
    })),
    appUpdateStatus: null,
    checkingAppUpdate: false,
    onCheckAppUpdate: vi.fn(async () => undefined),
    onDownloadAppUpdate: vi.fn(async () => undefined),
    onCancelAppUpdateDownload: vi.fn(async () => undefined),
    onInstallAppUpdate: vi.fn(async () => undefined),
    onOpenAppRelease: vi.fn(async () => undefined),
    onUnarchive: vi.fn(),
    onLoadBackendProfile: vi.fn(),
    onCreateBackendProfile: vi.fn(),
    onUpdateBackendProfile: vi.fn(),
    onSetBackendCredential: vi.fn(),
    onClearBackendCredential: vi.fn(),
    onProbeBackendProfile: vi.fn(),
    onDeleteBackendProfile: vi.fn(async () => undefined),
    onSetBackendDefault: vi.fn(async () => undefined),
    onClearBackendDefault: vi.fn(async () => undefined),
  };
}

describe("Settings composite updates", () => {
  it("announces a sanitized application-update action failure", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    const props = settingsProps(vi.fn(async () => undefined));
    render(<SettingsView
      {...props}
      appUpdateStatus={{
        revision: 1,
        state: "available",
        freshness: "fresh",
        delivery: "in-app",
        deliveryReason: null,
        installBlocker: null,
        progress: null,
        currentVersion: "0.0.35",
        latestVersion: "0.0.36",
        releaseUrl: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.36",
        checkedAt: "2030-01-01T00:00:00.000Z",
        lastAttemptedAt: "2030-01-01T00:00:00.000Z",
        message: "Inertia 0.0.36 is available.",
      }}
      onDownloadAppUpdate={vi.fn(async () => {
        throw new Error("private transport detail");
      })}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByText("The update download could not be started."))
      .toHaveAttribute("role", "status");
  });

  it("shows persisted default sentinels and saves the concrete provider default", () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    const onUpdate = vi.fn(async () => undefined);
    const props = {
      ...settingsProps(onUpdate),
      providers: [codexWithModels()],
    };
    const view = render(<SettingsView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));

    const model = screen.getByLabelText("Model");
    const reasoning = screen.getByLabelText("Reasoning");
    expect(model).toHaveValue("");
    expect(model).toHaveDisplayValue(
      "Provider default — GPT-5.6-Sol",
    );
    expect(reasoning).toHaveValue("");
    expect(reasoning).toHaveDisplayValue("Model default — Low");

    fireEvent.change(model, { target: { value: "gpt-5.6-sol" } });
    expect(onUpdate).toHaveBeenLastCalledWith({
      defaultModel: "gpt-5.6-sol",
      defaultReasoningEffort: "low",
    });

    view.rerender(<SettingsView
      {...props}
      settings={{
        ...defaultSettings,
        defaultModel: "gpt-5.6-sol",
        defaultReasoningEffort: "xhigh",
      }}
    />);
    expect(model).toHaveValue("gpt-5.6-sol");
    expect(model).toHaveDisplayValue("GPT-5.6-Sol — Default");
    expect(reasoning).toHaveValue("xhigh");
    expect(reasoning).toHaveDisplayValue("Xhigh");
  });

  it("saves the Discord release repository and webhook URLs", () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getPlatform: () => "darwin",
        listInertiaReleases: vi.fn(async () => []),
      },
    });
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView
      {...settingsProps(onUpdate)}
      providers={[codexWithModels(), provider("claude", "Claude")]}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Discord" }));
    const repository = screen.getByLabelText("Discord release repository URL");
    expect(repository).toHaveValue("");

    fireEvent.change(repository, {
      target: {
        value: "https://github.com/eduardtomas1/inertia",
      },
    });

    expect(onUpdate).toHaveBeenLastCalledWith({
      discordReleaseRepositoryUrl: "https://github.com/eduardtomas1/inertia",
    });

    const webhook = screen.getByLabelText("Discord webhook URL");
    expect(webhook).toHaveValue("");

    fireEvent.change(webhook, {
      target: {
        value: "https://discord.com/api/webhooks/test/token",
      },
    });

    expect(onUpdate).toHaveBeenLastCalledWith({
      discordWebhookUrl: "https://discord.com/api/webhooks/test/token",
    });

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "codex:gpt-5.6-sol" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({
      discordReleaseProvider: "codex",
      discordReleaseModel: "gpt-5.6-sol",
      discordReleaseReasoningEffort: "low",
    });

    fireEvent.change(screen.getByLabelText("Reasoning"), {
      target: { value: "xhigh" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({
      discordReleaseReasoningEffort: "xhigh",
    });
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });

  it("sends the latest release info to Discord", async () => {
    const previousRelease = {
      tag: "v0.0.40",
      name: "Inertia 0.0.40",
      url: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.40",
      createdAt: "2030-01-02T03:04:05.000Z",
      releasedAt: "2030-01-02T04:04:05.000Z",
      description: "Previous release notes",
    };
    const release = {
      tag: "v0.0.41",
      name: "Inertia 0.0.41",
      url: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.41",
      createdAt: "2030-01-03T03:04:05.000Z",
      releasedAt: "2030-01-03T04:04:05.000Z",
      description: "Release notes",
    };
    const sendDiscordReleaseInfo = vi.fn(async () => ({ sent: true as const }));
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getPlatform: () => "darwin",
        listInertiaReleases: vi.fn(async () => [release, previousRelease]),
        sendDiscordReleaseInfo,
      },
    });
    render(<SettingsView
      {...settingsProps(vi.fn(async () => undefined))}
      providers={[codexWithModels(), provider("claude", "Claude")]}
      settings={{
        ...defaultSettings,
        discordReleaseRepositoryUrl: "https://github.com/eduardtomas1/inertia",
        discordReleaseModel: "gpt-5.6-sol",
        discordReleaseReasoningEffort: "xhigh",
        discordWebhookUrl: "https://discord.com/api/webhooks/test/token",
      }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Discord" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() =>
      expect(window.inertia.listInertiaReleases).toHaveBeenCalledWith({
        repositoryUrl: "https://github.com/eduardtomas1/inertia",
      }));
    await waitFor(() =>
      expect(sendDiscordReleaseInfo).toHaveBeenCalledWith({
        webhookUrl: "https://discord.com/api/webhooks/test/token",
        repositoryUrl: "https://github.com/eduardtomas1/inertia",
        previousRelease,
        release,
      }));
    expect(await screen.findByText("Release info sent to Discord."))
      .toHaveAttribute("role", "status");
  });

  it("preserves a dirty alias through an equivalent snapshot refresh", () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    const onUpdate = vi.fn(async () => undefined);
    const props = settingsProps(onUpdate);
    const view = render(<SettingsView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    const alias = screen.getAllByLabelText("Name in Inertia")[0]!;
    alias.focus();
    expect(alias).toHaveFocus();
    fireEvent.change(alias, { target: { value: "Unsaved Codex name" } });

    view.rerender(
      <SettingsView
        {...props}
        settings={{
          ...defaultSettings,
          providerIdentityLabels: {},
        }}
      />,
    );

    expect(alias).toHaveValue("Unsaved Codex name");
    expect(alias).toHaveFocus();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("merges rapid alias and shortcut edits before a snapshot round trip", () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsProps(onUpdate)} />);

    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    const aliases = screen.getAllByLabelText("Name in Inertia");
    fireEvent.change(aliases[0]!, { target: { value: "Team Codex" } });
    fireEvent.blur(aliases[0]!);
    fireEvent.change(aliases[1]!, { target: { value: "Team Claude" } });
    fireEvent.blur(aliases[1]!);

    expect(onUpdate).toHaveBeenLastCalledWith({
      providerIdentityLabels: {
        codex: "Team Codex",
        claude: "Team Claude",
      },
    });

    onUpdate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Keybindings" }));
    fireEvent.change(screen.getByLabelText("Search everything key"), {
      target: { value: "g" },
    });
    fireEvent.change(screen.getByLabelText("New chat key"), {
      target: { value: "h" },
    });

    expect(onUpdate).toHaveBeenLastCalledWith({
      keybindings: {
        ...defaultSettings.keybindings,
        search: "g",
        "new-chat": "h",
      },
    });
  });

  it("clears a rejected alias draft so the same value can be retried", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    const onUpdate = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    render(<SettingsView {...settingsProps(onUpdate)} />);
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    const alias = screen.getAllByLabelText("Name in Inertia")[0]!;

    fireEvent.change(alias, { target: { value: "Team Codex" } });
    fireEvent.blur(alias);
    await waitFor(() => expect(alias).toHaveValue(""));

    fireEvent.change(alias, { target: { value: "Team Codex" } });
    fireEvent.blur(alias);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith({
      providerIdentityLabels: { codex: "Team Codex" },
    });
  });

  it("preserves aliases edited while an earlier save is rejecting", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    let rejectSave = (_error: Error): void => {
      throw new Error("The alias save did not start.");
    };
    const onUpdate = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    }));
    render(<SettingsView {...settingsProps(onUpdate)} />);
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    const aliases = screen.getAllByLabelText("Name in Inertia");

    fireEvent.change(aliases[0]!, { target: { value: "Saving Codex" } });
    fireEvent.blur(aliases[0]!);
    expect(onUpdate).toHaveBeenCalledOnce();

    fireEvent.change(aliases[0]!, { target: { value: "New Codex draft" } });
    fireEvent.change(aliases[1]!, { target: { value: "New Claude draft" } });
    await act(async () => {
      rejectSave(new Error("offline"));
    });

    expect(aliases[0]).toHaveValue("New Codex draft");
    expect(aliases[1]).toHaveValue("New Claude draft");
    expect(onUpdate).toHaveBeenCalledOnce();
  });
});
