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
