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
  it("keeps healthy local metrics visible beside bounded partial warnings", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getPlatform: () => "darwin",
        getAppHealth: vi.fn(async () => ({
          sampledAt: "2030-01-02T03:04:05.000Z",
          totalMemoryBytes: 30 * 1_024 * 1_024,
          mainProcess: {
            pid: 10,
            cpuPercent: 1.2,
            memoryBytes: 10 * 1_024 * 1_024,
          },
          rendererProcesses: [{
            pid: 20,
            cpuPercent: 2.4,
            memoryBytes: 20 * 1_024 * 1_024,
          }],
          runtimeProcess: null,
          runtimePhase: "ready",
          databaseBytes: 4_096,
          cacheBytes: null,
          temporaryAttachmentBytes: 512,
          warnings: [{
            code: "cache",
            message: "Browser cache storage could not be measured.",
          }],
        })),
      },
    });
    render(<SettingsView {...settingsProps(vi.fn(async () => undefined))} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive & data" }));

    expect(await screen.findByText("Partial health data")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Browser cache storage could not be measured.",
    );
    expect(screen.getByText("30 MB")).toBeVisible();
    expect(screen.getByText("4.0 KB")).toBeVisible();
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(screen.getByText(/UI 20 MB across 1 process/u)).toBeVisible();
    expect(screen.getByText("Partial health data").parentElement)
      .toBe(screen.getByRole("status"));
  });

  it("shows the isolated Canary channel and reverified rollback action", async () => {
    const openCanaryRollback = vi.fn(async () => ({
      state: "ready" as const,
      version: "0.0.40",
      message: "Opened the verified Canary 0.0.40 rollback package.",
    }));
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getPlatform: () => "darwin",
        getCanaryRollbackStatus: vi.fn(async () => ({
          state: "ready" as const,
          version: "0.0.40",
          message: "Verified Canary 0.0.40 is retained for rollback.",
        })),
        openCanaryRollback,
      },
    });
    const props = settingsProps(vi.fn(async () => undefined));
    render(<SettingsView {...props} appUpdateStatus={{
      revision: 1,
      channel: "canary",
      state: "current",
      freshness: "fresh",
      delivery: "in-app",
      deliveryReason: null,
      installBlocker: null,
      progress: null,
      currentVersion: "0.0.41",
      latestVersion: "0.0.41",
      releaseUrl: "https://github.com/eduardtomas1/inertia/releases/tag/canary-v0.0.41",
      checkedAt: "2030-01-01T00:00:00.000Z",
      lastAttemptedAt: "2030-01-01T00:00:00.000Z",
      message: "Inertia Canary is up to date.",
    }} />);

    expect(screen.getByText("Inertia Canary · v0.0.48")).toBeInTheDocument();
    expect(await screen.findByText("Canary channel · isolated profile")).toBeInTheDocument();
    expect(await screen.findByText("Verified Canary 0.0.40 is retained for rollback."))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open rollback v0.0.40" }));
    await waitFor(() => expect(openCanaryRollback).toHaveBeenCalledTimes(1));
  });

  it("labels the Linux rollback action as a verified file replacement", async () => {
    const openCanaryRollback = vi.fn(async () => ({
      state: "ready" as const,
      version: "0.0.40",
      message: "Quit Canary and replace the active AppImage with the revealed file.",
    }));
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getPlatform: () => "linux",
        getCanaryRollbackStatus: vi.fn(async () => ({
          state: "ready" as const,
          version: "0.0.40",
          message: "Verified Canary 0.0.40 is retained for rollback.",
        })),
        openCanaryRollback,
      },
    });
    render(<SettingsView {...settingsProps(vi.fn(async () => undefined))} appUpdateStatus={{
      revision: 1,
      channel: "canary",
      state: "current",
      freshness: "fresh",
      delivery: "in-app",
      deliveryReason: null,
      installBlocker: null,
      progress: null,
      currentVersion: "0.0.41",
      latestVersion: "0.0.41",
      releaseUrl: "https://github.com/eduardtomas1/inertia/releases/tag/canary-v0.0.41",
      checkedAt: "2030-01-01T00:00:00.000Z",
      lastAttemptedAt: "2030-01-01T00:00:00.000Z",
      message: "Inertia Canary is up to date.",
    }} />);

    fireEvent.click(await screen.findByRole("button", {
      name: "Show rollback file v0.0.40",
    }));
    await waitFor(() => expect(openCanaryRollback).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(
      "Quit Canary and replace the active AppImage with the revealed file.",
    )).toBeInTheDocument();
  });

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
      channel: "stable",
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
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));

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

  it("opens providers in a selected master-detail editor with model metadata", () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    render(<SettingsView
      {...settingsProps(vi.fn(async () => undefined))}
      providers={[codexWithModels(), provider("claude", "Claude")]}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    expect(screen.getByRole("button", { name: "Configure Codex" }))
      .toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("tab", { name: /Models/u }));
    expect(screen.getByText("GPT-5.6-Sol", { exact: true })).toBeVisible();
    expect(screen.getByText("gpt-5.6-terra", { exact: true })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Configure Claude" }));
    expect(screen.getByRole("tab", { name: "Configuration" }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Name in Inertia"))
      .toHaveAttribute("placeholder", "Claude account");
  });

  it("moves provider detail tabs with the composite keyboard pattern", () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    render(<SettingsView
      {...settingsProps(vi.fn(async () => undefined))}
      providers={[codexWithModels()]}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    const configuration = screen.getByRole("tab", {
      name: "Configuration",
    });
    configuration.focus();
    fireEvent.keyDown(configuration, { key: "ArrowRight" });

    const models = screen.getByRole("tab", { name: /Models/u });
    expect(document.activeElement).toBe(models);
    expect(models).toHaveAttribute("aria-selected", "true");
    expect(models).toHaveAttribute("tabindex", "0");
    expect(configuration).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel"))
      .toHaveAttribute("aria-labelledby", "provider-settings-models-tab");

    fireEvent.keyDown(models, { key: "Home" });
    expect(document.activeElement).toBe(configuration);
    expect(configuration).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "provider-settings-configuration-tab",
    );
  });

  it("keeps the Discord webhook in privileged credential storage", async () => {
    const getBackendCredentialState = vi.fn(async () => ({
      profileId: "discord-release-webhook",
      hasSecret: false,
      maskedValue: null,
      credentialGeneration: null,
      storage: { available: true, provider: "keychain" as const, message: null },
    }));
    const setBackendCredential = vi.fn(async () => ({
      profileId: "discord-release-webhook",
      hasSecret: true,
      maskedValue: "••••••••" as const,
      credentialGeneration: "webhook-generation",
      storage: { available: true, provider: "keychain" as const, message: null },
    }));
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getPlatform: () => "darwin",
        getBackendCredentialState,
        setBackendCredential,
        clearBackendCredential: vi.fn(),
      },
    });
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView
      {...settingsProps(onUpdate)}
      providers={[codexWithModels(), provider("claude", "Claude")]}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Discord" }));
    await waitFor(() => expect(getBackendCredentialState).toHaveBeenCalledWith({
      profileId: "discord-release-webhook",
    }));
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
    expect(onUpdate).not.toHaveBeenCalledWith(expect.objectContaining({
      discordWebhookUrl: expect.anything(),
    }));
    fireEvent.click(screen.getByRole("button", { name: "Save webhook" }));
    await waitFor(() => expect(setBackendCredential).toHaveBeenCalledWith({
      profileId: "discord-release-webhook",
      secret: "https://discord.com/api/webhooks/test/token",
    }));
    expect(webhook).toHaveValue("");
    expect(webhook).toHaveAttribute("placeholder", "••••••••");
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Reasoning")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });

  it("sends the latest release info to Discord", async () => {
    const sendDiscordReleaseInfo = vi.fn(async () => ({ sent: true as const }));
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getPlatform: () => "darwin",
        getBackendCredentialState: vi.fn(async () => ({
          profileId: "discord-release-webhook",
          hasSecret: true,
          maskedValue: "••••••••" as const,
          credentialGeneration: "webhook-generation",
          storage: { available: true, provider: "keychain" as const, message: null },
        })),
        setBackendCredential: vi.fn(),
        clearBackendCredential: vi.fn(),
        sendDiscordReleaseInfo,
      },
    });
    render(<SettingsView
      {...settingsProps(vi.fn(async () => undefined))}
      providers={[codexWithModels(), provider("claude", "Claude")]}
      settings={{
        ...defaultSettings,
        discordReleaseRepositoryUrl: "https://github.com/eduardtomas1/inertia",
      }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Discord" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() =>
      expect(sendDiscordReleaseInfo).toHaveBeenCalledWith({
        repositoryUrl: "https://github.com/eduardtomas1/inertia",
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
    const codexAlias = screen.getByLabelText("Name in Inertia");
    fireEvent.change(codexAlias, { target: { value: "Team Codex" } });
    fireEvent.blur(codexAlias);
    fireEvent.click(screen.getByRole("button", { name: "Configure Claude" }));
    const claudeAlias = screen.getByLabelText("Name in Inertia");
    fireEvent.change(claudeAlias, { target: { value: "Team Claude" } });
    fireEvent.blur(claudeAlias);

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
    const alias = screen.getByLabelText("Name in Inertia");

    fireEvent.change(alias, { target: { value: "Saving Codex" } });
    fireEvent.blur(alias);
    expect(onUpdate).toHaveBeenCalledOnce();

    fireEvent.change(alias, { target: { value: "New Codex draft" } });
    await act(async () => {
      rejectSave(new Error("offline"));
    });

    expect(alias).toHaveValue("New Codex draft");
    fireEvent.click(screen.getByRole("button", { name: "Configure Claude" }));
    fireEvent.change(screen.getByLabelText("Name in Inertia"), {
      target: { value: "New Claude draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Configure Codex" }));
    expect(screen.getByLabelText("Name in Inertia")).toHaveValue("New Codex draft");
    fireEvent.click(screen.getByRole("button", { name: "Configure Claude" }));
    expect(screen.getByLabelText("Name in Inertia")).toHaveValue("New Claude draft");
    expect(onUpdate).toHaveBeenCalledOnce();
  });
});
