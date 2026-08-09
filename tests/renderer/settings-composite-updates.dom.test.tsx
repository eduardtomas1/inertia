import { fireEvent, render, screen } from "@testing-library/react";
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
  it("merges rapid alias and shortcut edits before a snapshot round trip", () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getPlatform: () => "darwin" },
    });
    const onUpdate = vi.fn();
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
});
